import { Fragment, useEffect, useRef, useState } from "react";
import { ApiError, ask, type AskTurn } from "./api";
import type { Session } from "./types";

interface Props {
  session: Session | null;
  postcodes: string[]; // one for a report, several when comparing
  suggestions: string[];
  onUnlock: (feature: string) => void;
}

// Ask Overnight: questions about the data, answered by Claude as it writes.
// The conversation starts afresh whenever the postcodes change.
export default function AskBox({ session, postcodes, suggestions, onUnlock }: Props) {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; upgrade?: boolean } | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const key = postcodes.join(",");
  const allowed = session?.features["ask"]?.allowed ?? false;

  useEffect(() => {
    setTurns([]);
    setError(null);
    return () => abort.current?.abort();
  }, [key]);

  if (!session?.ask_ready) return null;

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    if (!allowed) return onUnlock("ask");
    const history: AskTurn[] = [...turns, { role: "user", text: q }];
    setTurns([...history, { role: "assistant", text: "" }]);
    setDraft("");
    setError(null);
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const append = (t: string) =>
      setTurns((ts) => {
        const last = ts[ts.length - 1];
        return [...ts.slice(0, -1), { ...last, text: last.text + t }];
      });
    // On failure, drop the unanswered question so it can be asked again.
    const fail = (message: string, upgrade = false) => {
      setTurns((ts) => ts.slice(0, -2));
      setDraft(q);
      setError({ message, upgrade });
    };
    try {
      await ask(
        postcodes,
        history,
        (e) => {
          if ("text" in e) append(e.text);
          else if ("left" in e) setLeft(e.left);
          else if ("error" in e) fail(e.error);
        },
        ctrl.signal,
      );
    } catch (e) {
      if (ctrl.signal.aborted) return;
      fail(e instanceof Error ? e.message : "Couldn't ask just now.", e instanceof ApiError && e.body.unlocks_on === "pro");
    } finally {
      if (abort.current === ctrl) setBusy(false);
    }
  };

  const several = postcodes.length > 1;
  return (
    <section className="ask" aria-label="Ask Overnight">
      <div className="ask-head">
        <h2>Ask Overnight</h2>
        <span className="small muted">{left != null ? `${left} left today` : "Answers from this data, by Claude"}</span>
      </div>

      {turns.length === 0 && (
        <div className="ask-chips">
          {suggestions.map((s) => (
            <button key={s} className="chip" onClick={() => send(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>
      )}

      {turns.length > 0 && (
        <div className="ask-thread" aria-live="polite">
          {turns.map((t, i) =>
            t.role === "user" ? (
              <p key={i} className="ask-q">
                {t.text}
              </p>
            ) : (
              <div key={i} className="ask-a">
                {t.text ? <Answer text={t.text} /> : <span className="ask-typing" aria-label="Thinking" />}
              </div>
            ),
          )}
        </div>
      )}

      {error && (
        <p className="small error">
          {error.message}{" "}
          {error.upgrade && (
            <button className="link small" onClick={() => onUnlock("compare")}>
              Support Overnight for more
            </button>
          )}
        </p>
      )}

      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={turns.length ? "Ask a follow-up" : several ? "Ask about these postcodes" : "Ask about this postcode"}
          aria-label="Your question"
          maxLength={500}
          disabled={busy}
        />
        <button type="submit" className="primary" disabled={busy || !draft.trim()}>
          {allowed ? "Ask" : "Sign up to ask"}
        </button>
      </form>
      <p className="small muted ask-note">Claude can make mistakes. It only sees the numbers on this page; check anything important.</p>
    </section>
  );
}

// A tiny, safe renderer for the little formatting Claude is asked to use:
// paragraphs, "- " bullets and **bold**. No HTML is ever injected.
function Answer({ text }: { text: string }) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      blocks.push({ list: false, lines: [] });
      continue;
    }
    const bullet = /^[-•*]\s+/.test(line);
    const last = blocks[blocks.length - 1];
    const body = line.replace(/^[-•*]\s+/, "");
    if (last && last.list === bullet && last.lines.length && bullet) last.lines.push(body);
    else if (last && !bullet && !last.list && last.lines.length) last.lines.push(body);
    else blocks.push({ list: bullet, lines: [body] });
  }
  return (
    <>
      {blocks
        .filter((b) => b.lines.length)
        .map((b, i) =>
          b.list ? (
            <ul key={i}>
              {b.lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l} />
                </li>
              ))}
            </ul>
          ) : (
            <p key={i}>
              {b.lines.map((l, j) => (
                <Fragment key={j}>
                  {j > 0 && " "}
                  <Inline text={l} />
                </Fragment>
              ))}
            </p>
          ),
        )}
    </>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/).map((part, i) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}
