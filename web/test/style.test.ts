// Validates the aircraft map layers against MapLibre's style spec. MapLibre
// drops an invalid layer with only a console error, which once made every
// aircraft disappear. Run: npm test
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { AIRCRAFT_LAYERS, AIRCRAFT_SOURCES } from "../src/aircraftStyle.ts";

function validate(layers: unknown[]) {
  return validateStyleMin({
    version: 8,
    glyphs: "https://example.com/{fontstack}/{range}.pbf",
    sources: AIRCRAFT_SOURCES,
    layers,
  } as never);
}

const failures: string[] = [];

const errors = validate(AIRCRAFT_LAYERS);
for (const e of errors) failures.push(`aircraft layers: ${e.message}`);

// The validator must catch the bug that hid every aircraft: ["zoom"] nested
// inside another expression instead of a top-level interpolate.
const nested = validate([
  { id: "bad", type: "symbol", source: "ac", layout: { "icon-size": ["*", ["get", "size"], ["interpolate", ["linear"], ["zoom"], 8, 1, 16, 2]] } },
]);
if (!nested.some((e) => /zoom/.test(e.message))) failures.push("validator didn't flag a nested zoom expression");

if (failures.length) {
  console.error("FAIL\n" + failures.join("\n"));
  process.exit(1);
}
console.log(`PASS: ${AIRCRAFT_LAYERS.length} aircraft layers are valid`);
