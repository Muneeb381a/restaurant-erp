/**
 * Labels an owner can put on a dish for the guest (QR) menu. The codes are stored in the database
 * (CHECK constraints in migration 0014 list the same values) and translated by the app.
 */
export const GUEST_TAGS = ['HALAL', 'VEGETARIAN', 'SPICY', 'CHEF', 'NEW'] as const;
export type GuestTag = (typeof GUEST_TAGS)[number];

/** The common allergens a guest asks about. "Contains …" is shown, never "free from". */
export const ALLERGENS = [
  'MILK',
  'GLUTEN',
  'NUTS',
  'EGG',
  'SOY',
  'FISH',
  'SESAME',
  'SHELLFISH',
] as const;
export type Allergen = (typeof ALLERGENS)[number];

/** Image kinds accepted for a dish photo, recognised by their first bytes (the declared type is not trusted). */
export function sniffImage(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const b = bytes;
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return 'image/png';
  if (
    b.length > 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // RIFF
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50 // WEBP
  )
    return 'image/webp';
  return null;
}
