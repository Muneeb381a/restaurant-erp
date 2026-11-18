# Redesign 2026 — "Counter Light"

Why: the first design (warm paper, pine green, flat hairlines) was calm but read as dated and low
contrast: beige on beige, little hierarchy, text-only tiles, an alarm-red bar on every screen. The owner
asked for a complete, professional redesign after research.

## What the research says (and what it does not)
Sources are mostly vendor guides and reviews; there is no formal standard for POS layouts. We use them
as convergent practice, not as proof.

| Finding | Source | What we do |
|---|---|---|
| One decision per screen; the order and payment screens stay uncluttered | [dev.pro, 10 POS UX tactics](https://dev.pro/insights/designing-a-pos-system-ten-user-experience-tactics-that-improve-usability/) | Order screen = menu on the left, one cart on the right, one primary action |
| Large touch targets (56 px+, 60 px primary), sticky context header, sticky cart with a dominant pay button | [POS & sales entry UI guide](https://www.skills.lc/peterbamuhigire/skills-web-dev/peterbamuhigire-skills-web-dev-pos-sales-ui-design-skill-md) (single doc, not a standard) | 48 px minimum kept, 56 px primary; cart footer is sticky |
| Modifiers are a top source of order mistakes: make them simple and hard to get wrong | [Snappy, ease of use](https://gosnappy.io/blog/?p=10869) | Already chips; kept, plus category colour on tiles |
| Toast is praised for a dense but navigable interface and colour-coded buttons that can be changed on the fly | [TechRadar](https://www.techradar.com/news/the-best-pos-system-for-restaurants), Capterra reviews via [Capterra](https://www.capterra.com/restaurant-pos-software/s/iphone/) | Category-coloured menu tiles; calm neutral chrome so the colour carries meaning |
| Extensive training means poor design | [Snappy](https://gosnappy.io/blog/?p=10869) | The next step is always one big coloured button that says what it does |
| KDS: age shown by colour that escalates (green, yellow, red), saturated colours readable from across the kitchen, large type, whole-ticket touch regions, light and dark themes | [Toast KDS docs](https://doc.toasttab.com/doc/platformguide/platformKDSOverview.html), [vp0 KDS UI](https://vp0.com/blogs/restaurant-kitchen-display-system-kds-ui/), [crumb KDS](https://crumb-pos.vercel.app/blog/kds-best-practices) | Kitchen goes dark with age-coloured ticket headers (it already has the age bar) |
| Station filtering speeds the line | vendor claim, unverified | Already present (station tabs) |

Not found: published usability studies on table-map layouts or Pakistani restaurant POS. Table layout
choices below are our own judgement and must be checked with real cashiers.

## What was wrong (audit of the screens, 1280x800 and 390x800)
1. Warm beige page + beige sidebar + beige cards: nothing separates surfaces; hierarchy is flat.
2. Free tables are dashed, empty, low-contrast; occupied tables are big saffron blocks: the colour is
   loud where it matters least (a busy table is the normal state).
3. Menu tiles are text boxes of equal weight: nothing groups dishes by kind.
4. A full-width red "printer offline" bar sits above every screen, even where printing is irrelevant.
5. Navigation: dark header + light sidebar + dark chips: three competing chromes.

## Principles
- **Calm chrome, loud meaning.** Neutrals carry structure; colour is reserved for state and action
  (the colour roles in UI-GUIDE stay: saffron = in kitchen/occupied, blue = bill ready, green = pay /
  ready, ink = served, red = late/danger).
- **Light surfaces, one dark rail.** Content on cool near-white, cards white with a hairline and a soft
  shadow, one dark navigation rail on the left (it frames the work area and never competes with it).
- **Contrast first.** Text 700-900 on 50-100; every status chip passes 4.5:1; white on filled buttons
  uses 600-700 shades only.
- **Numbers are the product.** Tabular, lining figures, larger totals, aligned right.
- **Same everywhere.** The change is made in the design tokens and the shared component classes, so
  every screen (including admin tables, dialogs, receipts' on-screen preview) changes together; screens
  with a special job (floor, order, kitchen, login) get a layout pass on top.
- Urdu RTL and 48 px touch targets are unchanged requirements.

## System
- Neutrals: cool slate (`50 #f7f8fa` … `900 #101828`). Radius 10/12/16. Shadows: `0 1px 2px` for cards,
  `0 12px 32px` for sheets. Font stays IBM Plex Sans (+ Arabic) because it is bundled and works offline.
- Brand/go green `#0a7d4b`-family; attention saffron `#f79009`-family; danger `#d92d20`-family;
  bill blue `#175cd3`-family.
- Category colours for menu tiles: 8 hues picked by a stable hash of the category id, never the only
  signal (the name is always there).

## Screen changes
Shell: dark rail with the brand on top, white top bar with context chips and the account. Floor: tables
as compact cards by area, state shown by a coloured top edge and chip, free tables calm. Order: category
coloured tiles, white cart with a sticky total and one primary button. Kitchen: dark theme, big ticket
headers coloured by age. Login: lighter and simpler. Printer-offline notice: a small chip in the top
bar, not a screen-wide bar.
