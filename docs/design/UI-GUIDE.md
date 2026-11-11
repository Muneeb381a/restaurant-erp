# UI guide — Restaurant POS

Who uses this: a cashier or waiter, standing, one hand free, in a noisy room, often in Urdu, on a
tablet or a phone. They do the same ten things all shift. The screen must never make them think.

## 1. Principles

1. **One screen = one job, one obvious next step.** Each screen has exactly one primary button.
   It is labelled with the outcome ("Send to kitchen", "Take payment · Rs 1,540"), never "OK".
2. **Say why when something is disabled.** A greyed button always has a short sentence under it
   ("Rs 500 still to be covered by a payment"). No silent dead ends.
3. **State is visible, not remembered.** Tables, lines and bills show their state in words
   ("Not sent", "In kitchen", "Bill ready · 12 min"). Colour is never the only signal.
4. **Rare things are out of the way.** Hold, move, merge, cancel live under **More**; discount and
   cancel-bill live behind quiet buttons. The common path has no clutter.
5. **Mistakes are cheap to undo, dangerous things are explicit.** Destructive actions are outlined
   red, ask for a reason, and never share a row with the primary button.
6. **The server is the source of truth.** The UI shows server totals; it only previews (change due,
   remaining) and never decides money.
7. **Works with no internet.** Fonts and icons are bundled. No CDN, no remote images.

## 2. Navigation

| Area | Where | Notes |
| --- | --- | --- |
| Tables, Bills, Khata, Drawer, Admin | Left rail (tablet/desktop) · bottom bar (phone) | Icon **and** label, 48 px+ targets. Items appear only if the user has the permission. |
| Business day + shift | One pill, top right | Always says where you are ("Day open · 2026-11-11 / Shift open"). Amber when a step is missing; its menu offers exactly the next step. |
| Language, log out | Account menu, top right | |
| Order actions | **More** in the cart header | Hold/resume, move table, merge, cancel order. |

Admin has its own sidebar grouped by job: *Menu & tables · Stock & costs · People & access · Business*.

## 3. Look

- **Type**: IBM Plex Sans (Latin) + IBM Plex Sans Arabic (Urdu), bundled in `public/fonts`.
  Tabular lining numerals everywhere so money lines up. Urdu is set 1.0625 rem / 1.75 line height.
- **Colour** (tokens in `tailwind.config.js`; the default palettes are replaced):
  `slate` = warm paper/ink, `emerald` = pine (go: take payment, free, success),
  `amber` = saffron (attention, in progress), `rose` = chilli (danger, unpaid),
  `sky` = slate blue (bill ready).
- **Surfaces**: flat, hairline borders, 6–10 px radius, no decorative shadows. Shadow only lifts
  overlays (`shadow-sheet`).
- **Targets**: 48 px minimum (`min-h-touch`), 56 px for the primary action (`btn-lg`).
- **Focus**: 3 px saffron ring for keyboard users.

## 4. Components (`apps/web/src/components`, classes in `index.css`)

| Piece | Use |
| --- | --- |
| `.btn-primary` | The one next step. Max one per screen/dialog. |
| `.btn-secondary` | Alternatives. |
| `.btn-quiet` | Low-emphasis actions (Back, Remove, Void). |
| `.btn-danger`, `.btn-danger-quiet` | Destructive. Solid only inside a confirm dialog. |
| `.seg` / `.seg-item` | Filters and either/or choices (`aria-pressed`). |
| `.chip-ok/-warn/-bad/-info/-mute` | Status words ("In kitchen", "Not sent", "Paid"). |
| `Modal` | The only overlay. Centred dialog on tablets, bottom sheet on phones; primary action pinned in the footer; Esc / backdrop close unless it holds a half-typed form. |
| `toast()` | Short confirmations ("Sent to the kitchen: BBQ"). Errors that need action stay inline. |
| `Icon` | Bundled SVG set; always beside a text label. |

## 5. Writing

- Buttons are verbs or outcomes: *Send to kitchen*, *Take payment*, *Add discount*.
- Helper lines tell the user what to do next, in a full short sentence.
- Errors say what happened and what to do, in plain words. No codes on screen.
- Every string exists in `en.json` **and** `ur.json`.

## 6. Urdu / RTL

- Use logical properties (`ms-`, `me-`, `ps-`, `start-`, `end-`), never `left/right`.
- Mirror directional icons with `data-flip` on `Icon`.
- Wrap numbers, codes and amounts in `ltr()` so they stay left-to-right inside Urdu text.

## 7. Checklist for a new screen

- [ ] One primary action, labelled with the outcome?
- [ ] Every disabled control explained?
- [ ] Empty, loading and error states written?
- [ ] 48 px targets, works one-handed on a phone width (360 px)?
- [ ] Both languages, RTL checked?
- [ ] Keyboard focus visible, dialog traps focus and closes on Esc?
