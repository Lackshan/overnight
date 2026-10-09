// Package billing upgrades users through Stripe Checkout. A user becomes Pro
// either when they land back on the app (Confirm, instant) or when Stripe's
// webhook arrives (backup, and the only path for cancellations).
package billing

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/stripe/stripe-go/v87"
	"github.com/stripe/stripe-go/v87/webhook"

	"overnight/internal/auth"
	"overnight/internal/config"
	"overnight/internal/store"
)

type Billing struct {
	sc            *stripe.Client
	webhookSecret string
	appURL        string
	priceID       string
	mode          string // "subscription" or "payment"
	store         store.Store
}

var ErrNotConfigured = errors.New("payments aren't set up: STRIPE_SECRET_KEY or the Pro price ID is missing")

func New(secretKey, webhookSecret, appURL string, pro config.Plan, priceID string, st store.Store) *Billing {
	b := &Billing{webhookSecret: webhookSecret, appURL: appURL, priceID: priceID, mode: pro.CheckoutMode, store: st}
	if b.mode == "" {
		b.mode = "subscription"
	}
	if secretKey != "" {
		b.sc = stripe.NewClient(secretKey)
	}
	return b
}

func (b *Billing) ready() error {
	if b.sc == nil || b.priceID == "" {
		return ErrNotConfigured
	}
	return nil
}

// Checkout starts a Stripe Checkout session for the Pro plan and returns its URL.
func (b *Billing) Checkout(ctx context.Context, u *auth.User, returnPath string) (string, error) {
	if err := b.ready(); err != nil {
		return "", err
	}
	if returnPath == "" || returnPath[0] != '/' {
		returnPath = "/"
	}
	p := &stripe.CheckoutSessionCreateParams{
		Mode:              stripe.String(b.mode),
		ClientReferenceID: stripe.String(u.ID),
		LineItems: []*stripe.CheckoutSessionCreateLineItemParams{
			{Price: stripe.String(b.priceID), Quantity: stripe.Int64(1)},
		},
		SuccessURL:          stripe.String(b.appURL + returnPath + "?checkout=success&session_id={CHECKOUT_SESSION_ID}"),
		CancelURL:           stripe.String(b.appURL + returnPath + "?checkout=cancelled"),
		AllowPromotionCodes: stripe.Bool(true),
	}
	p.AddMetadata("user_id", u.ID)
	if b.mode == "subscription" {
		p.SubscriptionData = &stripe.CheckoutSessionCreateSubscriptionDataParams{}
		p.SubscriptionData.AddMetadata("user_id", u.ID)
	}
	if acct, _ := b.store.Get(ctx, u.ID); acct != nil && acct.CustomerID != "" {
		p.Customer = stripe.String(acct.CustomerID)
	} else if u.Email != "" {
		p.CustomerEmail = stripe.String(u.Email)
	}
	s, err := b.sc.V1CheckoutSessions.Create(ctx, p)
	if err != nil {
		return "", err
	}
	return s.URL, nil
}

// Confirm checks a finished Checkout session belongs to u and upgrades them.
func (b *Billing) Confirm(ctx context.Context, u *auth.User, sessionID string) error {
	if err := b.ready(); err != nil {
		return err
	}
	s, err := b.sc.V1CheckoutSessions.Retrieve(ctx, sessionID, nil)
	if err != nil {
		return err
	}
	if s.ClientReferenceID != u.ID {
		return errors.New("that checkout belongs to a different account")
	}
	return b.fulfil(ctx, s)
}

func (b *Billing) fulfil(ctx context.Context, s *stripe.CheckoutSession) error {
	if s.Status != stripe.CheckoutSessionStatusComplete || s.PaymentStatus == stripe.CheckoutSessionPaymentStatusUnpaid {
		return errors.New("payment isn't complete yet")
	}
	a := store.Account{UserID: s.ClientReferenceID, Plan: config.PlanPro}
	if s.Customer != nil {
		a.CustomerID = s.Customer.ID
	}
	if s.Subscription != nil {
		a.SubscriptionID = s.Subscription.ID
	}
	return b.store.Put(ctx, a)
}

// Portal returns a Stripe customer portal URL so Pro users can cancel or update their card.
func (b *Billing) Portal(ctx context.Context, u *auth.User, returnPath string) (string, error) {
	if b.sc == nil {
		return "", ErrNotConfigured
	}
	acct, err := b.store.Get(ctx, u.ID)
	if err != nil {
		return "", err
	}
	if acct == nil || acct.CustomerID == "" {
		return "", errors.New("no billing account yet")
	}
	s, err := b.sc.V1BillingPortalSessions.Create(ctx, &stripe.BillingPortalSessionCreateParams{
		Customer:  stripe.String(acct.CustomerID),
		ReturnURL: stripe.String(b.appURL + returnPath),
	})
	if err != nil {
		return "", err
	}
	return s.URL, nil
}

// HandleWebhook verifies and applies a Stripe event.
func (b *Billing) HandleWebhook(ctx context.Context, payload []byte, sig string) error {
	if b.webhookSecret == "" {
		return errors.New("STRIPE_WEBHOOK_SECRET isn't set")
	}
	ev, err := webhook.ConstructEventWithOptions(payload, sig, b.webhookSecret,
		webhook.ConstructEventOptions{IgnoreAPIVersionMismatch: true})
	if err != nil {
		return fmt.Errorf("bad signature: %w", err)
	}
	switch ev.Type {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		var s stripe.CheckoutSession
		if err := s.UnmarshalJSON(ev.Data.Raw); err != nil {
			return err
		}
		if s.ClientReferenceID == "" {
			return nil // not one of ours
		}
		return b.fulfil(ctx, &s)
	case "customer.subscription.updated", "customer.subscription.deleted":
		var sub stripe.Subscription
		if err := sub.UnmarshalJSON(ev.Data.Raw); err != nil {
			return err
		}
		return b.syncSubscription(ctx, &sub, ev.Type == "customer.subscription.deleted")
	}
	return nil
}

func (b *Billing) syncSubscription(ctx context.Context, sub *stripe.Subscription, deleted bool) error {
	userID := sub.Metadata["user_id"]
	if userID == "" && sub.Customer != nil {
		if a, _ := b.store.ByCustomer(ctx, sub.Customer.ID); a != nil {
			userID = a.UserID
		}
	}
	if userID == "" {
		log.Printf("billing: subscription %s has no user", sub.ID)
		return nil
	}
	plan := config.PlanFree
	if !deleted && (sub.Status == stripe.SubscriptionStatusActive || sub.Status == stripe.SubscriptionStatusTrialing || sub.Status == stripe.SubscriptionStatusPastDue) {
		plan = config.PlanPro
	}
	a := store.Account{UserID: userID, Plan: plan, SubscriptionID: sub.ID}
	if sub.Customer != nil {
		a.CustomerID = sub.Customer.ID
	}
	return b.store.Put(ctx, a)
}
