# PiTech

A React app that turns a logged-in mobile device into a live photo-booth camera
and a logged-in PC into its preview display. Captured photos can be framed,
saved, and downloaded.

| Feature | Details |
| --- | --- |
| Auth | Shared 8-digit PIN access (`10031102`) signs into the PiTech account; no login or registration UI. |
| App access | The workspace (live booth and gallery) is gated behind the shared PIN. |
| Tabs | **Create** (frame + actions) and **My Images** (saved gallery). |
| Frame container | `ASSETS/frame.png` — the photo is rendered inside the frame's window |
| Live booth sync | Mobile publishes a WebRTC camera preview and captured stills to a paired display over Supabase Realtime signaling |
| Take Photo | Mobile camera only; the PC shows the live preview before capture |
| Zoom & pan | The photo inside the frame can be moved and zoomed — drag to reposition, scroll or pinch to zoom, double-click / double-tap to reset, plus zoom-out / zoom-in / reset buttons and keyboard control. 100 % fills the frame's opening; zoom out to set the photo on the white mat |
| Download | Exports the frame + photo as a 1080 × 1080 PNG — nothing else is stamped onto the export, no logos or branding |
| My Images | Saved framed photos — in IndexedDB |
| Storage limit | No application-level photo limit; saved framed photos remain until deleted. |
| Header / footer | Neomorphic site header (brand, tabs, account) and footer |
| Animations | Framer Motion — entrance, tab transitions, layout, and list animations |
| Hover / touch | Buttons grow slightly on hover — or while pressed on touch devices |

> Saved photos remain in the local IndexedDB gallery until deleted.

## Getting started

```bash
npm install
npm run dev
```

The app runs with **no configuration** — it falls back to a local mock for auth
and IndexedDB for the gallery. To connect Supabase, see
[Supabase setup](#supabase-setup).

Other scripts:

```bash
npm run build     # type-check and build to dist/
npm run preview   # preview the production build
npm run lint      # oxlint
```

## How it works

The original frame artwork is fully opaque, so there is no room for a photo. The
`scripts/generate-frame-cutout.ps1` script flood-fills the white area that forms the
photo window and writes `src/assets/frame-cutout.png` — the same frame with that window
made transparent.

At runtime the photo is rendered underneath that cut-out frame, so it shows through the
window with a pixel-perfect edge. The download button repeats the exact same compositing
on a `<canvas>` at 1080 × 1080.

### Live photo booth

After signing in, open **Create** on both devices. Choose **Mobile Camera** on
the phone and **Live Display** on the screen. Enter the six-digit code shown on
the phone into the display to pair them. The phone camera stream is sent directly
to the display with WebRTC; Supabase Realtime is used only for the signaling
handshake. Press **Capture Photo** on either device to send a still to the
display, where it can be positioned in the frame and downloaded. The display
can run on a PC, tablet, or another phone.

Supabase must be configured and both devices need internet access and a secure
origin (HTTPS, or localhost during development). The browser will ask the mobile
device for camera permission. Direct WebRTC connections may be unavailable on
some restrictive networks that require a TURN relay.

### Zooming and moving the photo

`src/lib/photo-transform.ts` holds the geometry shared by the preview and the
export. Everything is measured in *frame units* — one unit is one side of the
frame square — so the same numbers describe the on-screen photo and the 1080 px
canvas:

| Piece | Meaning |
| --- | --- |
| `coverFit(w, h)` | The "cover" fit against the frame's opening: the smallest size at which the photo still covers the whole window. This is what 100 % means |
| `photoRect(transform, fit)` | Where the photo is drawn — left, top, width, height in frame units, centred on the opening |
| `clampTransform(...)` | Keeps the photo honest: zoomed in it always covers the opening (it can never be dragged off the frame), zoomed out it always stays inside it (it can never be dragged out of the frame) |
| `zoomTo(...)` / `panBy(...)` | Zoom around an anchor point and move the photo, both clamped |

The window itself was measured from the artwork's alpha channel: the
transparent opening spans x 60…1019 and y 342…1019 of the 1080 px square. It is
the pivot for everything — 100 % means the photo exactly fills that opening.
Zooming out shrinks the photo onto the white mat inside the frame (down to
10 %), and zooming in crops it and lets you drag the crop around (up to 800 %).

Because the preview and `composeFrame()` share these functions, the downloaded
PNG is the framed photo exactly as it appears on screen — zoom and pan
included. The canvas is painted with the same white mat first, so a zoomed-out
photo exports with the mat around it, just like the preview. The transform
lives in `App.tsx` and resets whenever a new photo is picked.

| Input | Result |
| --- | --- |
| Drag (mouse or one finger) | Moves the photo inside the frame |
| Scroll wheel / trackpad pinch | Zooms around the pointer |
| Two-finger pinch | Zooms around the fingers and follows them |
| Double click / double tap | Back to the default fit (100 %) |
| Zoom out / in buttons | 1.4× steps, with a live percentage |
| Reset button | Back to the default fit |
| Arrow keys, `+` / `-`, `0` | Move, zoom and reset when the frame has focus |

The frame no longer grows on hover — a CSS scale on the frame would fight with
dragging — but the neomorphic shadow still reacts to hover.

The frame container is rounded in the UI only — the exported PNG keeps the artwork's
original square corners.

The container also carries an 8 px cream (`#f8eadc`) outline with a soft
neumorphic shadow cast outside it. Like the rounding, both are pure CSS and never
reach the export.

To regenerate the cut-out after replacing the frame artwork:

```powershell
pwsh -File scripts\generate-frame-cutout.ps1
```

## Layout

```
┌───────────────────────────────────────────────────────────┐
│  [◉] PiTech · Frame your memories           [Create][Images]│  ← header
├──────────────────────────────┬────────────────────────────┤
│                              │                            │
│      Frame + photo           │                            │
│      (frame-cutout.png       │                            │
│       layered on top)        │                            │
│      [− 100% + ⟳]            │                            │
│                              │  [Take] [Upload] [Download] │
├──────────────────────────────┴────────────────────────────┤
│  [◉] PiTech · © 2026                  Made with ♥          │  ← footer
│           Up to 5 photos can be stored per device.         │
└───────────────────────────────────────────────────────────┘
```

The **My Images** tab shows the saved gallery with a live `n / 5` counter. On
narrow screens the columns stack vertically and the header wraps into rows.

## Supabase setup

The app talks to Supabase through `src/lib/supabase.ts`. When
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are set, it uses **Supabase
Auth** and **Supabase Storage**; when they are missing it falls back to the
local mock and IndexedDB so the app still runs.

### 1. Credentials

Copy `.env.example` to `.env` and fill in both values (Supabase dashboard →
**Project Settings → API**):

```bash
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

The anon key is safe in the browser — Row Level Security is what protects your
data. Never put the `service_role` key in a `VITE_` variable; it bypasses RLS.

### 2. Local stack

The CLI and config are already in place (`supabase/config.toml`). Requires
Docker running and your user in the `docker` group.

```bash
npm run db:start    # supabase start — boots the local stack
npm run db:reset    # supabase db reset — apply migrations from scratch
npm run db:status   # supabase status — prints local URLs + keys
```

`supabase start` prints the local API URL and anon key; put those in `.env` for
local development.

### 3. Cloud project

The hosted project is created, linked, and migrated. Reference details:

| Setting | Value |
| --- | --- |
| Project | **AsperTheGhost** |
| Ref | `gjotiqtvajdjprvozjgq` |
| Region | `ap-southeast-1` |
| URL | `https://gjotiqtvajdjprvozjgq.supabase.co` |

To recreate this from scratch:

```bash
supabase login                # authenticate
supabase projects create AsperTheGhost --org-id <org-id> --region ap-southeast-1
supabase link --project-ref gjotiqtvajdjprvozjgq
npm run db:push               # apply migrations (table, trigger, policies, bucket)
```

The `photos` bucket is created by the second migration, so no manual dashboard
step is needed.

### 4. App access

The workspace is protected by the shared 8-digit PIN `10031102`. When Supabase
is configured, a correct PIN signs into the account configured through
`VITE_AUTH_EMAIL` and `VITE_AUTH_PASSWORD`. There are no user-facing login or
registration flows.

### 5. Schema

`supabase/migrations/` defines:

| Object | Purpose |
| --- | --- |
| `public.photo_slots` | One row per saved photo: owner, storage path, name |
| `enforce_photo_limit()` + trigger | Rejects the 6th insert for an owner — the 5-photo cap |
| RLS policies | Owners can only read/write their own rows |
| Storage policies | Owners can only touch objects under their own folder |
| `photos` bucket | Private, 10 MiB, PNG/JPEG/WebP only |

The limit is enforced in the database, so the client cannot bypass it. Verified
against the hosted project: the 6th insert fails with SQLSTATE `23514` and the
message *"You can save up to 5 photos on this device."*

## Auth

`src/lib/auth.ts` accepts the shared PIN and signs into the PiTech account when
Supabase is configured. Without Supabase, it stores a local fallback session.

## Gallery storage

`src/lib/gallery.ts` presents one interface (`listPhotos`, `addPhoto`,
`deletePhoto`, `releasePhotos`) over two backends:

- **Supabase Storage + `photo_slots`** when configured. Photos are uploaded to
  the private `photos` bucket under `<owner>/<id>.<ext>`, and the 5-photo cap is
  enforced by the database trigger — the client checks first for a fast error,
  and the trigger is the real guard.
- **IndexedDB** otherwise, keyed to the device, with the same cap enforced
  locally.

`MAX_PHOTOS_PER_DEVICE` is `5` and drives the gallery counter, the inline
notice, and the footer.

## Theme

Forest-green palette (derived from
[Color Hunt · 0107360d1c4222396ffcf1d0](https://colorhunt.co/palette/0107360d1c4222396ffcf1d0),
re-hued to green), used as **green accents on a white background**: the main app
surface is white, while buttons, icons, and the auth screen carry the green
gradient.

| Token | Value | Use |
| --- | --- | --- |
| Ink | `#062b16` | Headings, deepest green |
| Green | `#0b3a20` | Button gradient base |
| Emerald | `#16794a` | Button gradient top, accents |
| Cream | `#fcf1d0` | Text/icon colour on green |
| Background | `#ffffff` | Main app surface |

Brand tokens live in `src/index.css` (`--brand-ink`, `--brand-green`,
`--brand-emerald`, `--brand-cream`).

### Gradients

Gradients are CSS custom properties in `src/index.css`:

| Variable | Purpose |
| --- | --- |
| `--grad-green` | Buttons and icon pods (`#16794a` → `#083a22`) |
| `--grad-green-strong` | Stronger green for emphasis |
| `--grad-page` | Auth-screen backdrop (`app-backdrop`) |

Neomorphic surfaces (`neumorphic-card`, `neumorphic-frame`,
`neumorphic-button`) use soft light shadows tuned for the white surface.
`neumorphic-button` and the `icon-3d` pod paint the **green gradient**.

### Icons

Icons are flat, single-stroke line icons from [Lucide](https://lucide.dev),
rendered white. The dimensional "3D" look comes from the gradient pod
(`icon-3d` utility) they sit on — a green gradient tile with a top highlight,
an inset bottom shadow, and a cast shadow, so the whole element reads as a
raised, physical button.

`src/components/icons-3d.tsx` wraps the Lucide glyphs behind stable semantic
names (`Camera3D`, `Image3D`, `Wand3D`, `Download3D`, `ImagePlus3D`, `LogOut3D`,
`Mail3D`, `Lock3D`, `Trash3D`, `ImageOff3D`, …). Icons use `currentColor`, so
they take the colour of their container: **white** on the green gradient
buttons, and dark green where they sit on a light surface.

## Chrome

The **header** and **footer** are fixed full-width bars — pinned to the top and
bottom of the viewport with `position: fixed`, so they always stay visible while
the content scrolls. Both are translucent white bars with a subtle divider line.

Rather than guessing the bars' height with fixed padding, the workspace measures
them with a `ResizeObserver` (`headerRef` / `footerRef` in `src/App.tsx`) and
pads the scrolling content by their real height plus a comfortable gap. This
means the content can never be hidden behind the bars, whatever the screen size
or how the header wraps.

## Stack

- Vite + React 19 + TypeScript
- Tailwind CSS v4
- shadcn/ui (`base-nova` preset, base colour `mist`)
- [Motion](https://motion.dev) (Framer Motion) for animations
- [Lucide](https://lucide.dev) flat line icons (white, on green gradient pods)
- [Supabase](https://supabase.com) — Auth + Storage, with a local CLI stack (`supabase/config.toml`, `supabase/migrations/`)
