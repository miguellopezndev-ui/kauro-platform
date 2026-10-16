import type { CanonicalObject } from './canonical.js';

/**
 * Associations are edges, not decorative columns. A migration that keeps every
 * contact but loses which company each one works for has not preserved the
 * customer's data.
 *
 * The V1 support envelope covers relationships among Contact, Company and Deal
 * only. A Lead carries its company as a value on itself rather than through an
 * edge, which is what an unconverted lead is; there is no Lead relationship to
 * declare. Activity relationships are gone with the activities themselves.
 */

export const RELATIONSHIP_TYPES = [
  'CONTACT_TO_COMPANY',
  'CONTACT_TO_DEAL',
  'COMPANY_TO_DEAL',
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export interface RelationshipShape {
  readonly from: CanonicalObject;
  readonly to: CanonicalObject;
  readonly description: string;
}

export const RELATIONSHIP_SHAPES: Readonly<Record<RelationshipType, RelationshipShape>> = {
  CONTACT_TO_COMPANY: { from: 'CONTACT', to: 'COMPANY', description: 'A contact works at a company.' },
  CONTACT_TO_DEAL: { from: 'CONTACT', to: 'DEAL', description: 'A contact is involved in a deal.' },
  COMPANY_TO_DEAL: { from: 'COMPANY', to: 'DEAL', description: 'A deal belongs to a company.' },
};

export function relationshipShape(type: RelationshipType): RelationshipShape {
  return RELATIONSHIP_SHAPES[type];
}
