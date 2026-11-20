# ADR 0035 — The order menu looks like a kiosk menu

Status: accepted.

## Why
The counter person takes an order dozens of times an hour. The old menu was a row of small category chips and a grid of text tiles: fine for a waiter who knows the menu, slow for someone who has to find "Malai Boti" under BBQ. Burger-chain kiosks solved this: big category tiles with pictures, big dish cards with photos, everything one tap.

## What
- **Category rail** (tablet/desktop): a vertical rail of big tiles, each with a picture, its name and how many dishes it holds, plus "All" and "Popular". The active tile has the category's accent bar. On a phone the same tiles run across the top as a compact scrolling row.
- **The category picture is a photo of one of its own dishes** (the first with a photo), so nothing new has to be uploaded; with no photos it is a coloured tile with the first letter.
- **Dish cards**: a photo on top (4:3), the name (two lines), the price in bold; the card grid fills the width (`auto-fill`, 8.25 rem minimum). A plain dish already in the cart shows a − n + stepper on its own card; a dish that needs a sheet (sizes, extras, weight) shows a count badge. Sold-out dishes are greyed.
- **Adaptive**: cards show the photo area only when the restaurant has at least one dish photo; with none, compact cards (a coloured edge, bigger text) show more dishes at once.
- **Sub-categories** (BBQ → Regular, Special) stay a second row under the title, as before. The title says where you are and how many dishes are listed.
- **Search looks through the whole menu**, whatever category is open (nobody should have to guess where a dish is filed); "Search results" replaces the title.
- Behaviour did not change: same taps, same sheet, same cart, same server pricing. Accessibility names did too (`tab` for categories, dish buttons start with the dish name), so existing flows and tests keep working.

## Not done
Per-category pictures uploaded by the owner (the dish photo stands in); meal/combo bundles as a separate kiosk concept (deals already exist as dishes).
