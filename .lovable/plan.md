## What I found

I loaded your live site (problem1.lovable.app) in a browser and checked the published files:

- The compass code **is** deployed — the button exists in the page.
- But on the published site the floating compass button sits in the bottom-right corner **underneath the "Edit with Lovable" badge and the Leaflet attribution bar**, so on a phone it's mostly covered and looks missing/untappable. In the Lovable preview that badge isn't in the way, which is why it looks fine to you.
- The published page also throws React error #419 (a server-render Suspense failure) on first load, which can blank the map area briefly before it recovers.

## Plan

1. **Reposition / raise the compass control**
   - Move the collapsed compass button up above the attribution + badge strip (extra bottom offset, safe-area aware) and raise its stacking order so nothing overlaps it.
   - Apply the same offset to the expanded compass panel so its bottom rows (Start tracking / Center) aren't covered on small screens.
   - Verify at 600px-wide mobile viewport against the live layout.

2. **Remove the SSR Suspense error**
   - Render the lazily loaded map and compass only after hydration in a way that doesn't create a server-rendered Suspense boundary, so the published build stops throwing React #419 and paints cleanly on first load.

3. **Verify and republish**
   - Re-check the published URL in a headless browser: compass button visible and clickable, no page errors.
   - Note: publishing frontend changes requires clicking **Update** in the Publish dialog — I'll flag that when the fix is in.

Optional: if you're on a paid plan, the "Edit with Lovable" badge can be hidden entirely, which also frees that corner. Tell me if you want that.

## Technical notes

- `src/components/gps/GpsCompass.tsx`: change `bottom-4` to a larger, safe-area-aware offset (`bottom-[calc(env(safe-area-inset-bottom)+3.5rem)]`) on both the collapsed button and expanded panel; keep `z-[1000]` or raise as needed.
- `src/routes/index.tsx`: keep the `mounted` gate but drop the SSR-visible `Suspense` boundaries (mount-gated dynamic import) so no boundary is attempted during server rendering.
