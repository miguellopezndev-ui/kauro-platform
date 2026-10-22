// Who is in the canonical world: the Kauro owner, the customers' people, the workspaces (seven agencies, three companies and the read-only
// example), who belongs where with which role, and the agencies' clients. Names already used by the review (Northwind Data, Halden
// Outdoor, Lena Ortiz and her team, Tomas Reyes, Ana Silva) keep their ids from lib/world.ts and lib/contexts.ts. Every name is invented
// and every address uses a reserved domain (.example, example.com).
import type { Client, Membership, Owner, Person, Workspace } from "./types.ts";

/** The review's id family: one prefix, a 4-hex tail (lib/world.ts, lib/contexts.ts, prototypes/sales.ts use the same). */
export const uid = (tail: string): string => `0199c1a2-7b3d-7c4e-8a5f-1b2c3d4e${tail}`;

export const WS = {
  northwind: uid("5fa1"),
  halden: uid("5fb9"),
  coastline: uid("5fc1"),
  ridge: uid("5fc2"),
  juniper: uid("5fc3"),
  northwindLabs: uid("5fc4"),
  fjordline: uid("5fc5"),
  quillon: uid("5fc6"),
  larkspur: uid("5fd1"),
  brindle: uid("5fd2"),
  example: uid("5fe0"),
} as const;

export const SELLER = { daniel: uid("7c01"), amara: uid("7c02"), lucia: uid("7c03"), tomas: uid("7c04") } as const;

export const P = {
  lena: uid("7a01"),
  marco: uid("7a02"),
  priya: uid("7a03"),
  samuel: uid("7a04"),
  ines: uid("7a05"),
  ruth: uid("7a06"),
  tomasReyes: uid("7a07"),
  ana: uid("7a08"),
  grace: uid("7a09"),
  owen: uid("7a0a"),
  felix: uid("7a0b"),
  nadia: uid("7a0c"),
  kenji: uid("7a0d"),
  siobhan: uid("7a0e"),
  arne: uid("7a0f"),
  rafael: uid("7a10"),
  mei: uid("7a11"),
  jordan: uid("7a12"),
  ava: uid("7a13"),
  camila: uid("7a14"),
  andres: uid("7a15"),
} as const;

export const CLIENT = {
  larch: uid("7101"),
  osprey: uid("7102"),
  tidewell: uid("7103"),
  harbor: uid("7104"),
  haldenSelf: uid("7110"),
  atlas: uid("7121"),
  pemberton: uid("7122"),
  bluefin: uid("7131"),
  larkspurSelf: uid("7140"),
  wexford: uid("7151"),
  marisol: uid("7161"),
  hollowPine: uid("7171"),
  brindleSelf: uid("7180"),
  exampleLarch: uid("7e10"),
} as const;

export const OWNER: Owner = { id: uid("7a00"), name: "Kauro owner", email: "owner@kauro.example", origin: "OPS" };

const person = (id: string, name: string, email: string): Person => ({ id, name, email });

export const PEOPLE: readonly Person[] = [
  person(P.lena, "Lena Ortiz", "lena.ortiz@northwind.example"),
  person(P.marco, "Marco Bianchi", "marco.bianchi@northwind.example"),
  person(P.priya, "Priya Nair", "priya.nair@northwind.example"),
  person(P.samuel, "Samuel Osei", "samuel.osei@northwind.example"),
  person(P.ines, "Ines Duarte", "ines.duarte@northwind.example"),
  person(P.ruth, "Ruth Okafor", "ruth.okafor@northwind.example"),
  person(P.tomasReyes, "Tomas Reyes", "tomas.reyes@halden.example"),
  person(P.ana, "Ana Silva", "ana.silva@example.com"),
  person(P.grace, "Grace Liu", "grace.liu@coastline.example"),
  person(P.owen, "Owen Price", "owen.price@coastline.example"),
  person(P.felix, "Felix Moreau", "felix.moreau@ridgefennel.example"),
  person(P.nadia, "Nadia Haddad", "nadia.haddad@juniper.example"),
  person(P.kenji, "Kenji Watanabe", "kenji.watanabe@juniper.example"),
  person(P.siobhan, "Siobhan Doyle", "siobhan.doyle@fjordline.example"),
  person(P.arne, "Arne Lund", "arne.lund@fjordline.example"),
  person(P.rafael, "Rafael Quintero", "rafael.quintero@quillon.example"),
  person(P.mei, "Mei Chen", "mei.chen@quillon.example"),
  person(P.jordan, "Jordan Blake", "jordan.blake@larkspur.example"),
  person(P.ava, "Ava Moss", "ava.moss@larkspur.example"),
  person(P.camila, "Camila Rojas", "camila.rojas@brindleoak.example"),
  person(P.andres, "Andrés Mejía", "andres.mejia@brindleoak.example"),
];

const direct = { acquiredBySellerId: null, servedBySellerId: null, claimId: null } as const;
const export0 = (country: string) => ({ country, taxRateBps: 0 });
/** A Colombian buyer pays IVA at 19% on the service; the tax is collected for the state and is never Kauro's revenue. */
const colombia = { country: "CO", taxRateBps: 1900 } as const;

export const WORKSPACES: readonly Workspace[] = [
  { id: WS.northwind, name: "Northwind Data", kind: "AGENCY", state: "ACTIVE", restriction: null, createdAt: "2026-09-02T14:20:00Z", ...export0("US"), ...direct },
  { id: WS.coastline, name: "Coastline Analytics", kind: "AGENCY", state: "ACTIVE", restriction: null, createdAt: "2026-08-11T09:00:00Z", ...export0("US"), acquiredBySellerId: SELLER.daniel, servedBySellerId: SELLER.daniel, claimId: "c-10" },
  {
    id: WS.ridge,
    name: "Ridge & Fennel Consulting",
    kind: "AGENCY",
    state: "RESTRICTED",
    restriction: "New payment orders are paused until the billing contact confirms the company's details (support case 118).",
    createdAt: "2026-07-30T15:45:00Z",
    ...export0("CA"),
    ...direct,
  },
  { id: WS.juniper, name: "Juniper Digital", kind: "AGENCY", state: "ACTIVE", restriction: null, createdAt: "2026-10-05T12:10:00Z", ...export0("CA"), acquiredBySellerId: null, servedBySellerId: SELLER.daniel, claimId: "c-08" },
  { id: WS.northwindLabs, name: "Northwind Labs", kind: "AGENCY", state: "DRAFT", restriction: null, createdAt: "2026-10-18T16:40:00Z", ...export0("US"), ...direct },
  { id: WS.fjordline, name: "Fjordline Media", kind: "AGENCY", state: "ACTIVE", restriction: null, createdAt: "2026-08-28T10:30:00Z", ...export0("NO"), acquiredBySellerId: SELLER.amara, servedBySellerId: SELLER.amara, claimId: "c-09" },
  { id: WS.quillon, name: "Quillon Partners", kind: "AGENCY", state: "ACTIVE", restriction: null, createdAt: "2026-10-14T13:00:00Z", ...export0("US"), acquiredBySellerId: null, servedBySellerId: SELLER.tomas, claimId: "c-11" },
  { id: WS.halden, name: "Halden Outdoor", kind: "COMPANY", state: "ACTIVE", restriction: null, createdAt: "2026-09-20T10:05:00Z", ...colombia, acquiredBySellerId: SELLER.amara, servedBySellerId: SELLER.amara, claimId: "c-07" },
  { id: WS.larkspur, name: "Larkspur Home Goods", kind: "COMPANY", state: "ACTIVE", restriction: null, createdAt: "2026-10-15T16:00:00Z", ...export0("US"), acquiredBySellerId: SELLER.daniel, servedBySellerId: SELLER.daniel, claimId: "c-06" },
  { id: WS.brindle, name: "Brindle & Oak Furniture", kind: "COMPANY", state: "ACTIVE", restriction: null, createdAt: "2026-10-13T14:00:00Z", ...colombia, ...direct },
  { id: WS.example, name: "Example workspace", kind: "EXAMPLE", state: "ACTIVE", restriction: null, createdAt: "2026-10-01T00:00:00Z", ...export0("US"), ...direct },
];

const m = (personId: string, workspaceId: string, role: Membership["role"], since: string, state: Membership["state"] = "ACTIVE"): Membership => ({ personId, workspaceId, role, state, since });

/** Memberships. Lena Ortiz also belongs to four other workspaces, exactly as lib/world.ts MEMBERSHIPS.agency lists them. */
export const MEMBERSHIPS: readonly Membership[] = [
  m(P.lena, WS.northwind, "OWNER", "2026-09-02"),
  m(P.marco, WS.northwind, "ADMIN", "2026-09-03"),
  m(P.priya, WS.northwind, "OPERATOR", "2026-09-03"),
  m(P.samuel, WS.northwind, "APPROVER", "2026-09-04"),
  m(P.ines, WS.northwind, "BILLING", "2026-09-04"),
  m(P.ruth, WS.northwind, "VIEWER", "2026-09-10"),
  m(P.lena, WS.coastline, "OPERATOR", "2026-09-15"),
  m(P.lena, WS.ridge, "VIEWER", "2026-08-02"),
  m(P.lena, WS.juniper, "APPROVER", "2026-10-06", "SUSPENDED"),
  m(P.lena, WS.northwindLabs, "OWNER", "2026-10-18"),
  m(P.tomasReyes, WS.halden, "OWNER", "2026-09-20"),
  m(P.grace, WS.coastline, "OWNER", "2026-08-11"),
  m(P.owen, WS.coastline, "BILLING", "2026-08-12"),
  m(P.felix, WS.ridge, "OWNER", "2026-07-30"),
  m(P.nadia, WS.juniper, "OWNER", "2026-10-05"),
  m(P.kenji, WS.juniper, "ADMIN", "2026-10-05"),
  m(P.siobhan, WS.fjordline, "OWNER", "2026-08-28"),
  m(P.arne, WS.fjordline, "OPERATOR", "2026-08-29"),
  m(P.rafael, WS.quillon, "OWNER", "2026-10-14"),
  m(P.mei, WS.quillon, "APPROVER", "2026-10-14"),
  m(P.jordan, WS.larkspur, "OWNER", "2026-10-15"),
  m(P.ava, WS.larkspur, "BILLING", "2026-10-15"),
  m(P.camila, WS.brindle, "OWNER", "2026-10-13"),
  m(P.andres, WS.brindle, "OPERATOR", "2026-10-13"),
];

const c = (id: string, workspaceId: string, name: string, self = false): Client => ({ id, workspaceId, name, self });

export const CLIENTS: readonly Client[] = [
  c(CLIENT.larch, WS.northwind, "Larch Studio"),
  c(CLIENT.osprey, WS.northwind, "Osprey Freight"),
  c(CLIENT.tidewell, WS.northwind, "Tidewell"),
  c(CLIENT.harbor, WS.northwind, "Harbor Mill"),
  c(CLIENT.haldenSelf, WS.halden, "Halden Outdoor", true),
  c(CLIENT.atlas, WS.coastline, "Atlas Logistics"),
  c(CLIENT.pemberton, WS.coastline, "Pemberton Dental"),
  c(CLIENT.bluefin, WS.juniper, "Bluefin Retail"),
  c(CLIENT.larkspurSelf, WS.larkspur, "Larkspur Home Goods", true),
  c(CLIENT.wexford, WS.fjordline, "Wexford Events"),
  c(CLIENT.marisol, WS.quillon, "Marisol Travel"),
  c(CLIENT.hollowPine, WS.ridge, "Hollow Pine Co-op"),
  c(CLIENT.brindleSelf, WS.brindle, "Brindle & Oak Furniture", true),
  c(CLIENT.exampleLarch, WS.example, "Larch Studio (synthetic)"),
];
