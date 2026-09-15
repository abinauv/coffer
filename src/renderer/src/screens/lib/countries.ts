/*
 * The countries a business or a party can be in, for the Country picker (B13).
 *
 * Country was a free-text box that asked for "two-letter country code, lower case", which is
 * a format for a database and not a question for a person. The books still store the code —
 * that is what the regime reads, and what every existing record holds — so the picker offers
 * names and sends codes.
 *
 * THE CODES ARE A LIST AND THE NAMES ARE THE PLATFORM'S. ISO 3166-1 alpha-2 is a published,
 * slow-moving set; `Intl.DisplayNames` names each one from the ICU data Chromium ships, so no
 * table of 249 names is kept here to go stale or to be translated twice, and nothing is
 * fetched.
 *
 * A CODE THE LIST DOES NOT KNOW IS STILL OFFERED. A record saved from the old box may hold
 * anything two letters long, and a `<select>` whose value is not among its options shows the
 * first option without saying so — which would put the wrong country on the next save.
 */

export interface CountryOption {
  /** Lower case, as the books store it. */
  code: string
  label: string
}

/** ISO 3166-1 alpha-2, every officially assigned code. */
export const COUNTRY_CODES: readonly string[] = (
  'ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq ' +
  'br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm ' +
  'do dz ec ee eg eh er es et fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs ' +
  'gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn ' +
  'kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq ' +
  'mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm ' +
  'pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv ' +
  'sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug um us uy uz va vc ve vg vi ' +
  'vn vu wf ws ye yt za zm zw'
).split(' ')

/** The name a code resolves to, or the code itself where the platform has none. */
export function countryName(code: string): string {
  const upper = code.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(upper)) return code
  try {
    return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' }).of(upper) ?? upper
  } catch {
    return upper
  }
}

/**
 * Every country, by name, with the one a record already holds kept in the list even when it
 * is not a code the list knows.
 */
export function countryOptions(current: string): CountryOption[] {
  const options = COUNTRY_CODES.map((code) => ({ code, label: countryName(code) })).sort((a, b) =>
    a.label.localeCompare(b.label, 'en'),
  )
  const held = current.trim().toLowerCase()
  if (held !== '' && !COUNTRY_CODES.includes(held)) {
    options.unshift({ code: held, label: `${held.toUpperCase()} — not a country code` })
  }
  return options
}
