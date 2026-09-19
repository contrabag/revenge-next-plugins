# System Emoji

Replaces Unicode emoji in messages, the picker and native reaction pills with
the device's system emoji. Custom server emoji keep their image renderer.

This integration uses the supplied `system-emoji-dev` 1.1.5 TypeScript source
and the native beta3 reaction renderer confirmed working on the user's phone.
The plugin retains the main ID `contrabag.systememoji`.

## Changes in 1.8.0-beta1

- Integrates the fixed-size native reaction span, including hook cleanup and
  error/status reporting. No dependency on the missing BetterImageSpan class.
- Renders search rows with FlatList so large FakeNitro-expanded result sets do
  not create every image and pressable at once.
- Preserves custom search results, item disabled flags and Nitro section state;
  honors hidden IDs when provided. Dimmed items still call Discord's handlers,
  allowing FakeNitro to handle selection as before.
- Recognizes the slim `disabled` flag in the normal picker's existing lock check.
- Retains the supplied message, quick-reaction and normal-picker logic.

## Build and install locally

From your existing template repository, after setting up its native dependencies:

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
.\gradlew.bat packageSystemEmoji
```

Install `build/dist/contrabag.systememoji@1.8.0-beta1.zip`. Disable the separate
System Emoji DEV and System Reactions Test plugins, then fully restart Discord
so only this plugin installs the hooks. Native reaction code needs the same
RevengeXposed/native build setup as the working reaction test.

## Diagnostics

Replace CLIENT_ID with the active Revenge devtools connection:

```text
.run CLIENT_ID revenge.modules.native.callNativeMethod("contrabag.systememoji.reactions.status", []).then(s => console.log(JSON.stringify(s))).catch(e => console.log(String(e)))
```

An active native component reports `active: true` and `renderer: "fixed-slot-v3"`.
The replacement count should increase when Unicode reaction pills are created.
The bridge has no public per-method unregister; stop overwrites this plugin's
status method with an inactive response and removes its Xposed hooks. Existing
views need a reload to reset their spans.

## Validation

No Android or plugin bundle builds were run for this change. The picker hook was
tested with Node's built-in TypeScript stripping and a mocked React Native/JSX
host. Run with Node 24 from the repository root:

```text
node --test plugins/system-emoji/tests/picker-search.test.mjs
```

These checks cover a mixed 12,001-result search, lazy rendering, Unicode/custom
identity, GIF sources, press/long-press routing, disabled/hidden metadata, cleanup,
and invalid row-size fallback. They do not verify real FlatList layout or the
end-to-end behavior of FakeNitro on the phone.

Before release, check search with FakeNitro on/off, selecting both system and
custom results, long-press, clearing the query, normal picker categories, cold
reload, and the previously verified reaction dimensions. The source inspection
found eager search rendering and missing lock metadata; the user's exact search
symptom still needs confirmation with the integrated version.
