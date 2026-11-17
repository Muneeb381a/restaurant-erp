# ADR 0023 — The restaurant logo and people's photos live in the database

Status: accepted. Related: dish photos (migration 0014).

## Context
The owner wants the restaurant's logo and name on every printed bill, and a photo on their own account.
The till must keep working without internet (CLAUDE.md rule 9), and a cloud deployment (Vercel) has no
disk to keep files on.

## Decision
- Pictures are stored in Postgres (`branch_logo`, `user_avatars`), like the dish photos.
- The **browser prepares** them and the server only stores them and checks the numbers add up; the server
  never decodes an image (no new dependency, and nothing a hostile file can exploit):
  - logo: a PNG for the screen (≤ 300 KB) plus two dithered 1-bit rasters for the thermal printer, one per
    paper width (58 mm = 384 dots = 48 bytes a row, 80 mm = 576 dots = 72 bytes a row). The database
    checks `octet_length = bytes_per_row × height`.
  - photo: a 192 px square JPEG (≤ 150 KB), cropped in the browser.
- The receipt renderers (`packages/printing`) print the raster for the printer's paper above the
  restaurant name, in both English text mode (`GS v 0`) and the Urdu bitmap receipt. A bill printed from
  a browser (cloud) shows the PNG at the top.
- Who may change what: the logo needs `settings.manage` (audited `BRANCH_LOGO_SET/CLEAR`); a photo is the
  person's own (`/users/me/avatar`, audited), visible to others in the branch.
- `/auth/me` and the user list say only `avatarVersion` (a timestamp); the picture is fetched separately
  with the sign-in and cached by that version, so ordinary responses stay small.

## Consequences
- Logo and photos work offline and on serverless, and travel with the restaurant's database backup.
- A printed logo is black and white only (the printer's limit); the Settings screen previews exactly how it
  prints before saving.
- Big pictures are refused by size (the browser shrinks them first).
