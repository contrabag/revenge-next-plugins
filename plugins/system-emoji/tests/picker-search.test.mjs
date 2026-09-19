import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'

// Exercise the actual picker hook with a small JSX/RN host, without installing
// dependencies, bundling the plugin, or starting an Android build.
function host() {
    const hooks = []
    let removed = 0
    let renders = 0
    const context = {
        console,
        revenge: { patcher: { before(_target, _key, hook) {
            hooks.push(hook)
            return () => { removed++ }
        } } },
        plugin: value => value,
    }
    let source = readFileSync(new URL('../js/index.ts', import.meta.url), 'utf8')
    source = source.replace('export default plugin(', 'const definition = plugin(')
    vm.runInNewContext(stripTypeScriptTypes(source) + '\nglobalThis.api = { installPickerSearch, cleanupAll };', context)
    const rn = Object.fromEntries(['Text', 'Image', 'View', 'Pressable', 'FlatList'].map(key => [key, key]))
    const rt = { jsx(type, props, key) { renders++; return { type, props, key } } }
    context.api.installPickerSearch(rn, rt)
    return { hook: hooks[0], cleanup: context.api.cleanupAll, removed: () => removed, renders: () => renders }
}

test('mixed FakeNitro-style results are lazy, preserve order, and route presses by identity', () => {
    const h = host()
    const pressed = []
    const held = []
    const items = [{ name: 'grinning', surrogates: '😀' }, ...Array.from({ length: 12000 }, (_, i) => ({ id: String(i + 1), name: `custom${i}`, animated: i === 0 }))]
    const args = ['EmojiPickerView', {
        emojiData: { hasSearchData: true, rowSize: 9, data: [{ type: 3, emojis: items }] },
        onPressEmoji: event => pressed.push(event.nativeEvent),
        onLongPressEmoji: event => held.push(event.nativeEvent),
    }]
    h.hook(args)
    assert.equal(args[0], 'FlatList')
    assert.equal(h.renders(), 0, 'collecting matches must not create thousands of JSX cells')
    assert.equal(args[1].data.length, Math.ceil(items.length / 9))
    const buttons = args[1].renderItem({ item: args[1].data[0], index: 0 }).props.children
    assert.equal(buttons[0].props.children.type, 'Text')
    assert.equal(buttons[0].props.children.props.children, '😀')
    assert.equal(buttons[1].props.children.type, 'Image')
    assert.match(buttons[1].props.children.props.source.uri, /\/1\.gif\?/)
    buttons[0].props.onPress()
    buttons[1].props.onPress()
    buttons[1].props.onLongPress()
    assert.equal(pressed[0].emojiName, 'grinning')
    assert.equal(pressed[0].emojiId, undefined)
    assert.equal(pressed[1].emojiId, '1')
    assert.equal(held[0].emojiId, '1')
    h.cleanup()
    assert.equal(h.removed(), 1)
})

test('slim disabled flags, hidden IDs and Nitro section state survive search flattening', () => {
    const h = host()
    let presses = 0
    const args = ['EmojiPickerView', {
        emojiData: { hasSearchData: true, rowSize: 9, data: [
            { type: 3, emojisHidden: ['hidden'], emojis: [
                { id: 'hidden', name: 'hidden' }, { id: 'disabled', name: 'disabled', disabled: true },
            ] },
            { type: 3, isSectionNitroLocked: true, emojis: [{ id: 'nitro', name: 'nitro' }] },
            { type: 3, emojisDisabled: new Set(['set']), emojis: [{ id: 'set', name: 'set' }, { name: 'smile', surrogates: '😀' }] },
        ] },
        onPressEmoji() { presses++ },
    }]
    h.hook(args)
    const buttons = args[1].renderItem({ item: args[1].data[0], index: 0 }).props.children
    assert.equal(buttons.length, 4)
    for (const button of buttons.slice(0, 3)) {
        assert.equal(button.props.style.opacity, 0.35)
        button.props.onPress()
    }
    assert.equal(presses, 3, 'dimmed entries must still reach Discord/FakeNitro')
    assert.equal(buttons[3].props.style.opacity, 1)
})

test('normal picker and invalid search row sizes fall back without replacing native view', () => {
    const h = host()
    for (const [search, rowSize] of [[false, 9], [true, 0], [true, -1], [true, 1.5]]) {
        const args = ['EmojiPickerView', { emojiData: { hasSearchData: search, rowSize, data: [] } }]
        h.hook(args)
        assert.equal(args[0], 'EmojiPickerView')
    }
})
