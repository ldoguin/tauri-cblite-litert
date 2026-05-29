/**
 * unit-converter skill — converts between units of measurement.
 *
 * Supports: length, weight, temperature, speed, data, area, volume.
 * Temperature is handled separately (offset conversion, not a simple ratio).
 */
import type { Tool } from "../tools";

// Each category maps unit names (lowercase) → multiplier to reach the base unit.
const CONVERSIONS: Record<string, Record<string, number>> = {
  length: {
    m: 1, km: 1e3, cm: 1e-2, mm: 1e-3, um: 1e-6, nm: 1e-9,
    mi: 1609.344, ft: 0.3048, yd: 0.9144, in: 0.0254,
    "nautical mile": 1852, nmi: 1852,
  },
  weight: {
    kg: 1, g: 1e-3, mg: 1e-6, t: 1e3, lb: 0.45359237, oz: 0.028349523,
    st: 6.35029318, grain: 6.4799e-5,
  },
  speed: {
    "m/s": 1, "km/h": 1 / 3.6, mph: 0.44704, knot: 0.514444, "ft/s": 0.3048,
  },
  data: {
    b: 1, byte: 1,
    kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5,
    kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, pib: 1024 ** 5,
    // SI prefixes
    kilobyte: 1000, megabyte: 1e6, gigabyte: 1e9, terabyte: 1e12,
  },
  area: {
    "m2": 1, "m²": 1, "km2": 1e6, "km²": 1e6, "cm2": 1e-4, "cm²": 1e-4,
    "ft2": 0.092903, "ft²": 0.092903, "in2": 6.4516e-4, "in²": 6.4516e-4,
    acre: 4046.856, ha: 1e4, "mi2": 2.589988e6, "mi²": 2.589988e6,
  },
  volume: {
    "m3": 1, "m³": 1, l: 1e-3, ml: 1e-6, cl: 1e-5,
    "fl oz": 2.957353e-5, floz: 2.957353e-5, gal: 3.785411e-3,
    "uk gal": 4.546092e-3, qt: 9.46353e-4, pt: 4.73176e-4,
    cup: 2.36588e-4, tbsp: 1.47868e-5, tsp: 4.92892e-6,
    "ft3": 0.028317, "ft³": 0.028317, "in3": 1.6387e-5, "in³": 1.6387e-5,
  },
  pressure: {
    pa: 1, kpa: 1e3, mpa: 1e6, bar: 1e5, mbar: 100,
    atm: 101325, psi: 6894.757, torr: 133.322, mmhg: 133.322,
  },
  energy: {
    j: 1, kj: 1e3, mj: 1e6, wh: 3600, kwh: 3.6e6,
    cal: 4.184, kcal: 4184, btu: 1055.06, ev: 1.60218e-19,
  },
};

const TEMP_UNITS = new Set(["c","celsius","°c","f","fahrenheit","°f","k","kelvin","r","rankine"]);

function normUnit(u: string): string {
  return u.trim().toLowerCase().replace(/\s+/g, " ");
}

function toKelvin(v: number, u: string): number {
  const n = normUnit(u);
  if (n === "c" || n === "celsius" || n === "°c") return v + 273.15;
  if (n === "f" || n === "fahrenheit" || n === "°f") return (v - 32) * 5 / 9 + 273.15;
  if (n === "k" || n === "kelvin") return v;
  if (n === "r" || n === "rankine") return v * 5 / 9;
  throw new Error(`Unknown temperature unit: ${u}`);
}

function fromKelvin(k: number, u: string): number {
  const n = normUnit(u);
  if (n === "c" || n === "celsius" || n === "°c") return k - 273.15;
  if (n === "f" || n === "fahrenheit" || n === "°f") return (k - 273.15) * 9 / 5 + 32;
  if (n === "k" || n === "kelvin") return k;
  if (n === "r" || n === "rankine") return k * 9 / 5;
  throw new Error(`Unknown temperature unit: ${u}`);
}

export const unitConverterTool: Tool = {
  id: "unit_converter",
  name: "Unit Converter",
  description:
    "Converts a value between units. Supports length (m, km, mi, ft, in…), weight (kg, g, lb, oz…), " +
    "temperature (°C, °F, K), speed (m/s, km/h, mph, knot), data (B, KB, MB, GB, TB), " +
    "area (m², km², ft², acre, ha), volume (L, mL, gal, fl oz…), pressure (Pa, bar, psi, atm), energy (J, kJ, kWh, cal).",
  requiresNetwork: false,
  params: [
    { name: "value",  type: "number", description: "Numeric value to convert", required: true },
    { name: "from",   type: "string", description: "Source unit (e.g. km, lb, °C, mph, GB, m², L)", required: true },
    { name: "to",     type: "string", description: "Target unit (e.g. mi, kg, °F, km/h, MB, ft², fl oz)", required: true },
  ],
  async run({ value, from, to }) {
    const v = Number(value);
    if (isNaN(v)) return "Error: value must be a number";
    const f = normUnit(String(from));
    const t = normUnit(String(to));

    // Temperature
    if (TEMP_UNITS.has(f) || TEMP_UNITS.has(t)) {
      try {
        const result = fromKelvin(toKelvin(v, f), t);
        return `${v} ${from} = ${+result.toFixed(6)} ${to}`;
      } catch (e) { return `Error: ${String(e)}`; }
    }

    // Ratio-based categories
    for (const [category, units] of Object.entries(CONVERSIONS)) {
      const fromFactor = units[f];
      const toFactor   = units[t];
      if (fromFactor !== undefined && toFactor !== undefined) {
        const result = v * fromFactor / toFactor;
        // Avoid scientific notation for "normal" numbers
        const formatted = Math.abs(result) < 1e-4 || Math.abs(result) > 1e9
          ? result.toExponential(6)
          : +result.toPrecision(8);
        return `${v} ${from} = ${formatted} ${to}  [${category}]`;
      }
    }

    return (
      `Could not find a conversion from "${from}" to "${to}".\n` +
      "Supported categories: length, weight, temperature, speed, data, area, volume, pressure, energy."
    );
  },
};
