# Deck contract

HTML Presenter opens almost any single-file HTML deck. This page lists what it reads from a deck, so that people and tools that generate decks (for example a Claude skill) can make decks that get the most out of it. Everything here is optional: a deck that ignores all of it still opens.

## Checklist for a deck generator

1. One element per slide, all slides side by side in the same parent element.
2. A slide size: `<meta name="slide-size" content="1600x900">`.
3. A short title on every slide: `aria-label="Pricing"`.
4. A stable id on every slide: `data-slide-id="pricing"`. Keep the ids when you revise the deck.
5. Speaker notes that start with a time budget: `<aside class="notes">~1.5 min · …</aside>`.
6. No presenter window, grid or slide keyboard shortcuts of the deck's own.
7. Images, videos and fonts in the deck's folder (or embedded), referred to with relative paths.

## Slides

The app looks for slides in this order and uses the first rule that finds two or more: `deck-stage > section`, `.reveal .slides > section`, `.slides > section`, `section.slide`, `div.slide`, `.slide`, `[data-slide]`, `body > section`, `main > section`, `.step`, `body > article`, then the element with the most `<section>` children.

Reordering, duplicating and moving slides between decks needs all slides to share one parent element. An HTML comment right above a slide (`<!-- 3 Pricing -->`) moves with it.

If inactive slides are hidden until they get a class such as `on`, `active` or `current`, the app works out which class it is and sets it itself.

## Size

From `<deck-stage width="1920" height="1080">`, from `<meta name="slide-size" content="1600x900">`, or measured from the first slide. If none of those work, 1920×1080.

## Titles

The first of `aria-label`, `data-label`, `data-screen-label`, `data-title` and `title` on the slide element, otherwise the first `h1`, `h2`, `h3`, `header` or `.title` inside it.

## Stable slide ids

```html
<section class="slide" data-slide-id="pricing" aria-label="Pricing">
```

An id is lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters, and unique in the deck. It names the slide, not its position: when a deck is revised, a slide that is still the same slide keeps its id, and a new slide gets a new one. The app uses ids to recognise a slide after the file is regenerated, and includes them in what it copies for Claude.

**Slides → Ge slides fasta id** adds ids to slides that don't have one, made from their titles.

## Speaker notes

Any of:

```html
<section class="slide">… <aside class="notes">Shown only in the presenter view.</aside></section>
<section class="slide" data-notes="Also works as an attribute.">…</section>
<script type="application/json" id="speaker-notes">["Notes for slide 1", "Notes for slide 2"]</script>
```

The JSON list can also be `{"notes": [...]}` or `{"slides": [{"notes": "..."}]}`.

### Time budgets

Start a note with how long the slide should take. The presenter view then shows time on the slide against its budget, and whether you are ahead of or behind the plan for the whole talk.

```
~1.5 min · Say that the pilot ran for six weeks…
~45 s — Just the headline.
~2–3 min · A range counts as its middle.
```

The budget is `~`, `≈` or `ca`, then a number (`1.5` or `1,5`), optionally a range, then a unit: `min`, `mins`, `minuter`, `minutes`, `s`, `sek`, `sec`. Without the `~` the budget must be followed by `·`, `|`, `—`, `–`, `:` or a line break. Budgets over 60 minutes are ignored.

Slides without a budget share what is left of the talk length set in the presenter view, or get the average of the other slides.

## While a slide is shown

The app shows one slide at a time and handles the keyboard. When a slide is shown it dispatches a bubbling `hp:show` event on the slide element, with `event.detail.index`. Use it to start an entry animation or a demo:

```js
document.addEventListener('hp:show', (e) => { if (e.target.id === 'chart') drawChart(); });
```

`?slide=3` in the URL opens the deck on the fourth slide (counting from 0).

## Leave out

- **The deck's own presenter window, grid or notes panel**, for example one synced with `BroadcastChannel`. The app has them, and two presenter systems in one deck compete.
- **Keyboard shortcuts for slides.** The app takes every key press before the deck sees it, not only the ones it uses (arrows, Space, Enter, Page Up/Down, digits, B, W, G, T, S, F, N, P, Esc). Only text fields and other inputs inside a slide get their keys. For a demo that needs input, use a button or a text field on the slide.
- **Fullscreen requests** and requests for the camera, microphone, location or notifications. The app denies them.
- **`data-hp-…` attributes.** They belong to the app (`data-hp-id`, `data-hp-slide`, `data-hp-ui` and others). An element marked `data-hp-ui` is hidden and removed from edited text.

## Files and fonts

A deck can read files in its own folder and its subfolders, never outside it. Use relative paths (`img/chart.png`), or embed files as `data:` URLs.

Google Fonts linked with `<link href="https://fonts.googleapis.com/…">` or `@import` are saved by the app the first time the deck is shown with a network, and used from the saved copy after that, so the slides look the same without a network. The file itself is not changed. Other web fonts need a network; put them in the deck's folder to be safe. **Bildspel → Testa utan nät** shows the deck as it would look without one.

## Planned

These are not read yet, but are reserved so that generators can start emitting them:

- `data-optional` on a slide that can be skipped in a shorter version of the talk.
- `data-hp-step` on elements that should appear one click at a time.
