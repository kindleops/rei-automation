// NANP AREA CODE → PLAUSIBLE RECIPIENT ZONES (rc-8.5.21). Pure, static.
//
// Recipient-local evidence for the contact window: the area code of the RECIPIENT's phone (the
// seller texting us), not the property ZIP (an absentee owner lives elsewhere). An area code that
// straddles a zone boundary lists EVERY zone it covers (850: Eastern + Central); the caller then
// uses the intersection of the plausible zones' windows, so a straddling code can only narrow the
// lawful window, never widen it. Toll-free / non-geographic / Canadian / unknown codes return null
// (unknown is unknown: never a guessed zone).
//
// Number portability means an area code is evidence, not proof; reply-timing.js therefore always
// combines it with the property zone and any mailing-state zone (intersection of all of them).
export const NANP_AREA_ZONES_VERSION = 'nanp-area-zones.v1'

const ET = 'America/New_York'
const CT = 'America/Chicago'
const MT = 'America/Denver'
const AZ = 'America/Phoenix'
const PT = 'America/Los_Angeles'
const AK = 'America/Anchorage'
const HI = 'Pacific/Honolulu'
const PR = 'America/Puerto_Rico'

const RAW = {
  // single-zone states
  [ET]: [
    // CT DE DC GA ME MD MA NH NJ NY NC OH PA RI SC VT VA WV
    203, 475, 860, 959, 302, 202, 771, 229, 404, 470, 478, 678, 706, 762, 770, 912, 943, 207,
    227, 240, 301, 410, 443, 667, 339, 351, 413, 508, 617, 774, 781, 857, 978, 603,
    201, 551, 609, 640, 732, 848, 856, 862, 908, 973,
    212, 315, 332, 347, 363, 516, 518, 585, 607, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934,
    252, 336, 704, 743, 828, 910, 919, 980, 984,
    216, 220, 234, 326, 330, 380, 419, 440, 513, 567, 614, 740, 937,
    215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717, 724, 814, 835, 878, 401,
    803, 839, 843, 854, 864, 802, 276, 434, 540, 571, 703, 757, 804, 826, 948, 304, 681,
    // FL (Eastern codes)
    239, 305, 321, 324, 352, 386, 407, 561, 645, 656, 689, 727, 754, 772, 786, 813, 863, 904, 941, 954,
    // IN (Eastern-only codes), KY, MI, TN (Eastern-only)
    260, 317, 463, 765, 502, 859, 231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 947, 989, 865,
  ],
  [CT]: [
    205, 251, 256, 334, 659, 938, 327, 479, 501, 870,
    217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730, 773, 779, 815, 847, 872,
    319, 515, 563, 641, 712, 316, 913, 225, 318, 337, 504, 985, 218, 320, 507, 612, 651, 763, 952,
    228, 601, 662, 769, 314, 417, 557, 573, 636, 660, 816, 975, 402, 531, 405, 539, 572, 580, 918,
    615, 629, 731, 901, 931,
    210, 214, 254, 281, 325, 346, 361, 409, 430, 469, 512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 936, 940, 945, 956, 972, 979,
    262, 274, 414, 534, 608, 715, 920,
  ],
  [MT]: [303, 719, 720, 970, 983, 406, 505, 575, 385, 435, 801, 307, 915],
  [AZ]: [480, 520, 602, 623, 928],
  [PT]: [
    209, 213, 279, 310, 323, 341, 350, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669,
    707, 714, 747, 760, 805, 818, 820, 831, 840, 858, 909, 916, 925, 949, 951,
    206, 253, 360, 425, 509, 564, 702, 725, 503, 971,
  ],
  [AK]: [907],
  [HI]: [808],
  [PR]: [787, 939],
}

// codes whose territory straddles a zone line: every zone they cover
const SPLIT = {
  850: [ET, CT], 448: [ET, CT], // FL panhandle
  219: [CT, ET], 574: [ET, CT], 812: [ET, CT], 930: [ET, CT], // IN
  270: [CT, ET], 364: [CT, ET], 606: [ET, CT], // KY
  906: [ET, CT], // MI upper peninsula
  423: [ET, CT], // TN (Marion County is Central)
  432: [CT, MT], // TX (Culberson County is Mountain)
  620: [CT, MT], 785: [CT, MT], // KS
  308: [CT, MT], // NE
  701: [CT, MT], // ND
  605: [CT, MT], // SD
  541: [PT, MT], 458: [PT, MT], // OR (Malheur County)
  208: [MT, PT], 986: [MT, PT], // ID
  775: [PT, MT], // NV (West Wendover)
}

const TABLE = new Map()
for (const [zone, codes] of Object.entries(RAW)) {
  for (const c of codes) {
    // a code listed under two single zones is a table defect, never a silent last-wins
    if (TABLE.has(c) && !(c in SPLIT)) throw new Error(`NANP_AREA_ZONES_DUPLICATE:${c}`)
    TABLE.set(c, Object.freeze([zone]))
  }
}
for (const [code, zones] of Object.entries(SPLIT)) TABLE.set(Number(code), Object.freeze([...zones]))

/** The NPA of a US/NANP number in any common shape, or null. */
export function areaCodeOf(phone) {
  const d = String(phone ?? '').replace(/[^0-9]/g, '')
  const ten = d.length === 11 && d.startsWith('1') ? d.slice(1) : d.length === 10 ? d : null
  if (!ten || !/^[2-9][0-9]{2}[2-9]/.test(ten)) return null
  return Number(ten.slice(0, 3))
}

/** Plausible IANA zones for the recipient phone's area code; null when not a known geographic code. */
export function zonesForPhone(phone) {
  const npa = areaCodeOf(phone)
  if (npa == null) return null
  return TABLE.get(npa) || null
}

export const AREA_CODE_COUNT = TABLE.size
