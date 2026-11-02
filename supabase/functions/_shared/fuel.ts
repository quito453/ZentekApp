// Area fuel prices from public, free sources. Shared by the fuel-prices Edge Function (Deno) and the
// office app (the country, province/state and city pickers). No network calls in this file: it
// builds requests and reads responses, so it can be tested without the internet.
//
// Canada: Statistics Canada table 18-10-0001-01, "Monthly average retail prices for gasoline and fuel
//   oil, by geography". Cents per litre, self-serve, for 18 cities plus Canada. Monthly, published
//   with about a month's delay. https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1810000101
// United States: EIA weekly retail gasoline and diesel prices (API v2, route petroleum/pri/gnd).
//   Dollars per gallon. Nine states have their own series; every other state uses its region (PADD).
//   Updated every Monday. Needs a free API key: https://www.eia.gov/opendata/register.php
// Anywhere else: the owner types the price, and fuel receipts override it either way.

export type FuelType = "regular" | "diesel";
export type Country = "CA" | "US" | "OTHER";

export interface FuelQuote {
  pricePerL: number; // in the local currency
  currency: "CAD" | "USD";
  period: string; // YYYY-MM-DD: the week or month the price is for
  area: string; // where the average is for, e.g. "Toronto" or "New England (PADD 1A)"
  source: string; // short, for the screen: "Statistics Canada · Toronto · regular, self-serve"
  sourceUrl: string;
}

export const LITRES_PER_US_GALLON = 3.785411784;

export const FUEL_LABEL: Record<FuelType, string> = { regular: "Regular gasoline", diesel: "Diesel" };

// ───────────────────────────── Canada ─────────────────────────────
export const CA_PROVINCES: [string, string][] = [
  ["AB", "Alberta"], ["BC", "British Columbia"], ["MB", "Manitoba"], ["NB", "New Brunswick"], ["NL", "Newfoundland and Labrador"],
  ["NS", "Nova Scotia"], ["NT", "Northwest Territories"], ["NU", "Nunavut"], ["ON", "Ontario"], ["PE", "Prince Edward Island"],
  ["QC", "Quebec"], ["SK", "Saskatchewan"], ["YT", "Yukon"],
];

/** Cities Statistics Canada publishes prices for, by province. Names match the start of its geography names. */
export const STATCAN_CITIES: Record<string, string[]> = {
  NL: ["St. John's"], PE: ["Charlottetown and Summerside"], NS: ["Halifax"], NB: ["Saint John"],
  QC: ["Québec", "Montréal"], ON: ["Ottawa-Gatineau", "Toronto", "Thunder Bay"], MB: ["Winnipeg"],
  SK: ["Regina", "Saskatoon"], AB: ["Edmonton", "Calgary"], BC: ["Vancouver", "Victoria"], YT: ["Whitehorse"], NT: ["Yellowknife"], NU: [],
};

export const STATCAN_PID = 18100001;
export const STATCAN_WDS = "https://www150.statcan.gc.ca/t1/wds/rest";
export const STATCAN_TABLE_URL = "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1810000101";

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

const STATCAN_FUEL_MATCH: Record<FuelType, (name: string) => boolean> = {
  regular: (n) => n.includes("regular unleaded gasoline") && n.includes("self service"),
  diesel: (n) => n.includes("diesel") && n.includes("self service"),
};

type CubeMember = { memberId: number; memberNameEn: string };
type CubeDimension = { dimensionPositionId: number; dimensionNameEn: string; member: CubeMember[] };

/**
 * From getCubeMetadata, find the member ids for the city (or all of Canada when there's no city,
 * or the city isn't listed) and the fuel. Returns the 10-part coordinate the data call needs.
 */
export function statcanCoordinate(metadata: unknown, city: string | null, fuel: FuelType): { coordinate: string; area: string } | null {
  const obj = (metadata as { status?: string; object?: { dimension?: CubeDimension[] } }[])?.[0]?.object;
  const dims = obj?.dimension;
  if (!dims) return null;
  const geo = dims.find((d) => norm(d.dimensionNameEn) === "geography");
  const fuelDim = dims.find((d) => norm(d.dimensionNameEn).includes("fuel"));
  if (!geo || !fuelDim) return null;
  const want = city ? norm(city) : null;
  const geoMember =
    (want && geo.member.find((m) => norm(m.memberNameEn).startsWith(want))) || geo.member.find((m) => norm(m.memberNameEn) === "canada");
  const fuelMember = fuelDim.member.find((m) => STATCAN_FUEL_MATCH[fuel](norm(m.memberNameEn)));
  if (!geoMember || !fuelMember) return null;
  const parts = Array(10).fill(0);
  parts[geo.dimensionPositionId - 1] = geoMember.memberId;
  parts[fuelDim.dimensionPositionId - 1] = fuelMember.memberId;
  return { coordinate: parts.join("."), area: geoMember.memberNameEn.split(",")[0]!.trim() };
}

/** Reads getDataFromCubePidCoordAndLatestNPeriods. Values are cents per litre. */
export function readStatcan(data: unknown, area: string, fuel: FuelType): FuelQuote | null {
  const o = (data as { status?: string; object?: { vectorDataPoint?: { refPer: string; value: string | number | null; statusCode?: number }[] } }[])?.[0];
  if (o?.status !== "SUCCESS") return null;
  const points = (o.object?.vectorDataPoint ?? []).filter((p) => p.value !== null && p.value !== "" && Number(p.value) > 0);
  const last = points.sort((a, b) => b.refPer.localeCompare(a.refPer))[0];
  if (!last) return null;
  return {
    pricePerL: Math.round((Number(last.value) / 100) * 1000) / 1000,
    currency: "CAD",
    period: last.refPer.slice(0, 10),
    area,
    source: `Statistics Canada · ${area} · ${fuel === "regular" ? "regular" : "diesel"}, self-serve`,
    sourceUrl: STATCAN_TABLE_URL,
  };
}

// ───────────────────────────── United States ─────────────────────────────
export const US_STATES: [string, string][] = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"],
  ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"],
  ["IN", "Indiana"], ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"],
  ["ND", "North Dakota"], ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"],
  ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
];

/** States with their own EIA weekly regular-gasoline series. */
const EIA_STATE_SERIES = new Set(["CA", "CO", "FL", "MA", "MN", "NY", "OH", "TX", "WA"]);

// EIA regions (PADDs). PADD 1 is split into three sub-regions.
const PADD: Record<string, [string, string]> = {
  R1X: ["New England (PADD 1A)", "CT ME MA NH RI VT"],
  R1Y: ["Central Atlantic (PADD 1B)", "DE DC MD NJ NY PA"],
  R1Z: ["Lower Atlantic (PADD 1C)", "FL GA NC SC VA WV"],
  R20: ["Midwest (PADD 2)", "IL IN IA KS KY MI MN MO NE ND SD OH OK TN WI"],
  R30: ["Gulf Coast (PADD 3)", "AL AR LA MS NM TX"],
  R40: ["Rocky Mountain (PADD 4)", "CO ID MT UT WY"],
  R50: ["West Coast (PADD 5)", "AK AZ CA HI NV OR WA"],
};

/** EIA areas to try for a state, most local first: the state, its region, then the US average. */
export function eiaAreas(state: string, fuel: FuelType): { code: string; name: string }[] {
  const st = state.toUpperCase();
  const out: { code: string; name: string }[] = [];
  const name = US_STATES.find(([c]) => c === st)?.[1] ?? st;
  // Diesel has a state series only for California; regular has nine states.
  if (fuel === "regular" ? EIA_STATE_SERIES.has(st) : st === "CA") out.push({ code: `S${st}`, name });
  const region = Object.entries(PADD).find(([, [, states]]) => states.split(" ").includes(st));
  if (region) {
    if ((st === "OR" || st === "WA" || st === "AK" || st === "AZ" || st === "HI" || st === "NV") && region[0] === "R50") out.push({ code: "R5XCA", name: "West Coast except California" });
    out.push({ code: region[0], name: region[1][0] });
  }
  out.push({ code: "NUS", name: "U.S. average" });
  return out;
}

export function eiaUrl(apiKey: string, area: string, fuel: FuelType): string {
  const q = new URLSearchParams({
    api_key: apiKey,
    frequency: "weekly",
    "data[0]": "value",
    "facets[duoarea][]": area,
    "facets[product][]": fuel === "regular" ? "EPMR" : "EPD2D",
    "sort[0][column]": "period",
    "sort[0][direction]": "desc",
    length: "1",
  });
  return `https://api.eia.gov/v2/petroleum/pri/gnd/data/?${q.toString()}`;
}

/** Reads one EIA v2 data response. Values are US dollars per gallon. */
export function readEia(data: unknown, areaName: string, fuel: FuelType): FuelQuote | null {
  const rows = (data as { response?: { data?: { period: string; value: string | number | null }[] } })?.response?.data ?? [];
  const row = rows.find((r) => r.value !== null && r.value !== "" && Number(r.value) > 0);
  if (!row) return null;
  return {
    pricePerL: Math.round((Number(row.value) / LITRES_PER_US_GALLON) * 1000) / 1000,
    currency: "USD",
    period: String(row.period).slice(0, 10),
    area: areaName,
    source: `U.S. EIA · ${areaName} · ${fuel === "regular" ? "regular" : "diesel"}, weekly`,
    sourceUrl: "https://www.eia.gov/petroleum/gasdiesel/",
  };
}

/** What the pickers need to know for a country. */
export function fuelSupport(country: string): { auto: boolean; note: string } {
  if (country === "CA") return { auto: true, note: "Monthly city averages from Statistics Canada. They're published about a month late, so fuel receipts from your crews are used instead whenever you have them." };
  if (country === "US") return { auto: true, note: "Weekly averages from the U.S. Energy Information Administration, for your state where it has one, otherwise your region. Updated every Monday." };
  return { auto: false, note: "There's no free public source for your country yet. Type the price you pay; fuel receipts from your crews are used instead whenever you have them." };
}
