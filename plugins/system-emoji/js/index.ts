const { before } = revenge.patcher

const NativeChatModule =
    (globalThis as any).nativeModuleProxy?.NativeChatModule

let unpatches: Array<() => void> = []
let canonicalUnicode: any[] | null = null
let restoreLogNoise: (() => void) | null = null

/* =========================================================
 * CLEANUP
 * ======================================================= */

function cleanupAll() {
    try {
        restoreLogNoise?.()
    } catch {}

    restoreLogNoise = null

    for (let i = unpatches.length - 1; i >= 0; i--) {
        try {
            unpatches[i]?.()
        } catch {}
    }

    unpatches = []
}

function addUnpatch(unpatch: any) {
    if (typeof unpatch === "function") {
        unpatches.push(unpatch)
    }
}


/* =========================================================
 * QUIET KNOWN HARMLESS REACT NATIVE WARNINGS
 *
 * These are produced because Discord still has a few pieces
 * of native-picker bookkeeping around our replacement list.
 * We only hide exact/prefix-matched messages we have already
 * confirmed are harmless. All other logs still pass through.
 * ======================================================= */

function installLogNoiseFilter() {
    if (restoreLogNoise) return

    try {
        const consoleObject = console as any
        const originalWarn = consoleObject.warn
        const originalLog = consoleObject.log
        const originalInfo = consoleObject.info

        const shouldHide = (args: any[]) => {
            const first = args?.[0]
            if (typeof first !== "string") return false

            return (
                first ===
                    "Couldn't find the scrollable node handle id!" ||
                first.startsWith(
                    "InteractionManager has been deprecated and will be removed in a future release.",
                ) ||
                first.startsWith(
                    "VirtualizedList: You have a large list that is slow to update",
                )
            )
        }

        const wrap = (original: any) => {
            if (typeof original !== "function") return original

            return function (...args: any[]) {
                if (shouldHide(args)) return
                return original.apply(this, args)
            }
        }

        const wrappedWarn = wrap(originalWarn)
        const wrappedLog = wrap(originalLog)
        const wrappedInfo = wrap(originalInfo)

        consoleObject.warn = wrappedWarn
        consoleObject.log = wrappedLog
        consoleObject.info = wrappedInfo

        restoreLogNoise = () => {
            try {
                if (consoleObject.warn === wrappedWarn) {
                    consoleObject.warn = originalWarn
                }
            } catch {}

            try {
                if (consoleObject.log === wrappedLog) {
                    consoleObject.log = originalLog
                }
            } catch {}

            try {
                if (consoleObject.info === wrappedInfo) {
                    consoleObject.info = originalInfo
                }
            } catch {}
        }
    } catch {}
}

/* =========================================================
 * EXISTING MESSAGE SYSTEM EMOJI PATCH
 * ======================================================= */

function iterate(rows: any[]) {
    const content: any[] = []

    let header:
        | {
              type: "heading"
              level: number
              content: any[]
          }
        | undefined

    function flushHeader() {
        if (!header) return

        content.push(header)
        header = undefined
    }

    for (const original of rows) {
        let row = original

        if (row?.type === "emoji") {
            row = {
                type: "text",
                content: row.surrogate,
            }
        }

        if (
            row &&
            typeof row === "object" &&
            "content" in row &&
            Array.isArray(row.content)
        ) {
            row.content = iterate(row.content)
        }

        if (
            row &&
            typeof row === "object" &&
            "items" in row &&
            Array.isArray(row.items)
        ) {
            row.items = iterate(row.items)
        }

        if (original?.type === "customEmoji") {
            flushHeader()
            content.push(row)
            continue
        }

        if (
            original?.type === "emoji" &&
            original?.jumboable === true
        ) {
            if (!header) {
                header = {
                    type: "heading",
                    level: 1,
                    content: [],
                }
            }

            header.content.push(row)
            continue
        }

        if (
            header &&
            original?.type === "text" &&
            original?.jumboable === true
        ) {
            header.content.push(row)
            continue
        }

        flushHeader()
        content.push(row)
    }

    flushHeader()
    return content
}

function installMessagePatch() {
    if (!NativeChatModule?.updateRows) {
        console.error(
            "[SystemEmojis] NativeChatModule.updateRows not found",
        )
        return
    }

    try {
        const unpatch = before(
            NativeChatModule,
            "updateRows",
            (args) => {
                try {
                    if (typeof args[1] !== "string") {
                        return args
                    }

                    const rows = JSON.parse(args[1])

                    if (!Array.isArray(rows)) {
                        return args
                    }

                    for (const row of rows) {
                        try {
                            if (
                                row?.type !== 1 ||
                                !Array.isArray(
                                    row?.message?.content,
                                )
                            ) {
                                continue
                            }

                            row.message.content = iterate(
                                row.message.content,
                            )
                        } catch (error) {
                            console.error(
                                "[SystemEmojis] Failed to process row",
                                error,
                            )
                        }
                    }

                    args[1] = JSON.stringify(rows)
                } catch (error) {
                    console.error(
                        "[SystemEmojis] updateRows error",
                        error,
                    )
                }

                return args
            },
        )

        addUnpatch(unpatch)
    } catch (error) {
        console.error(
            "[SystemEmojis] Message patch failed",
            error,
        )
    }
}

/* =========================================================
 * MODULE LOOKUPS
 * ======================================================= */

function getRN(): any | null {
    try {
        const { lookupModules } = revenge.modules.finders
        const f = revenge.modules.finders.filters

        return [
            ...lookupModules(
                f.withProps("View", "Text", "Image"),
            ),
        ][0]?.[0] ?? null
    } catch {
        return null
    }
}

function getRawJSXRuntime(): any | null {
    try {
        const { lookupModules } = revenge.modules.finders
        const f = revenge.modules.finders.filters

        return [
            ...lookupModules(
                f.withProps("jsx", "jsxs"),
            ),
        ][0]?.[0] ?? null
    } catch {
        return null
    }
}

function getEmojiStore(): any | null {
    try {
        const { lookupModules } = revenge.modules.finders
        const f = revenge.modules.finders.filters

        return [
            ...lookupModules(
                f.withProps(
                    "searchWithoutFetchingLatest",
                    "getSearchResultsOrder",
                    "getGuildEmoji",
                ),
            ),
        ][0]?.[0] ?? null
    } catch {
        return null
    }
}

/* =========================================================
 * SHARED HELPERS
 * ======================================================= */

function flattenStyle(
    style: any,
): Record<string, any> {
    if (!style) return {}

    if (Array.isArray(style)) {
        const result: Record<string, any> = {}

        for (const entry of style) {
            Object.assign(
                result,
                flattenStyle(entry),
            )
        }

        return result
    }

    if (typeof style === "object") {
        return style
    }

    return {}
}

function decodeAssetEmoji(
    uri: any,
): string | null {
    if (typeof uri !== "string") {
        return null
    }

    const match = uri.match(
        /^asset:\/emoji-([0-9a-f-]+)\.png$/i,
    )

    if (!match) return null

    try {
        return match[1]
            .split("-")
            .map((part: string) =>
                String.fromCodePoint(
                    parseInt(part, 16),
                ),
            )
            .join("")
    } catch {
        return null
    }
}

function getTypeName(type: any): string {
    try {
        if (typeof type === "string") {
            return type
        }

        return type?.displayName || type?.name || ""
    } catch {
        return ""
    }
}

function hasSetLikeValue(
    collection: any,
    value: any,
): boolean {
    if (!collection || value == null) {
        return false
    }

    const stringValue = String(value)

    try {
        if (typeof collection.has === "function") {
            if (collection.has(value)) return true
            if (collection.has(stringValue)) return true
        }
    } catch {}

    try {
        if (Array.isArray(collection)) {
            return (
                collection.includes(value) ||
                collection.includes(stringValue)
            )
        }
    } catch {}

    try {
        if (typeof collection === "object") {
            return (
                Object.prototype.hasOwnProperty.call(
                    collection,
                    value,
                ) ||
                Object.prototype.hasOwnProperty.call(
                    collection,
                    stringValue,
                )
            )
        }
    } catch {}

    return false
}

function getEmojiName(item: any): string | null {
    const name =
        item?.name ??
        item?.uniqueName ??
        item?.emojiObject?.names?.[0]

    return typeof name === "string" && name.length > 0
        ? name
        : null
}

function getUnicodeSurrogate(
    item: any,
): string | null {
    const value =
        item?.surrogates ??
        item?.surrogate ??
        item?.emojiObject?.surrogates

    return typeof value === "string" && value.length > 0
        ? value
        : null
}

/* =========================================================
 * CAPTURE DISCORD'S CANONICAL UNICODE PICKER ORDER
 *
 * Discord's normal native picker only receives category
 * names/counts. The actual 1,932-item Unicode ordering is
 * available as the first Unicode candidate array passed to
 * EmojiStore.getSearchResultsOrder during an empty search.
 *
 * We patch only that one store method for one synchronous
 * call, copy the array, and immediately unpatch it.
 * ======================================================= */

function captureCanonicalUnicodeOrder(
    emojiStore: any,
): any[] | null {
    if (
        !emojiStore?.searchWithoutFetchingLatest ||
        !emojiStore?.getSearchResultsOrder
    ) {
        return null
    }

    let captured: any[] | null = null
    let temporaryUnpatch: any = null

    try {
        temporaryUnpatch = before(
            emojiStore,
            "getSearchResultsOrder",
            (args) => {
                try {
                    const candidate = args?.[0]

                    if (
                        !captured &&
                        Array.isArray(candidate) &&
                        candidate.length > 100
                    ) {
                        // FakeNitro can widen this candidate array so it
                        // contains Unicode plus thousands of custom emoji.
                        // Keep only Discord's Unicode search entries instead
                        // of assuming the entire first large array is the
                        // canonical Unicode catalog.
                        const unicodeCandidate =
                            candidate.filter((item: any) =>
                                item?.type === 0 &&
                                item?.id == null &&
                                typeof getUnicodeSurrogate(item) ===
                                    "string"
                            )

                        if (unicodeCandidate.length > 100) {
                            captured = unicodeCandidate.slice()

                            if (
                                unicodeCandidate.length !==
                                candidate.length
                            ) {
                                console.log(
                                    `[SystemEmojis] Canonical Unicode candidate filtered ${candidate.length} -> ${unicodeCandidate.length}`,
                                )
                            }
                        }
                    }
                } catch {}

                return args
            },
        )

        emojiStore.searchWithoutFetchingLatest({
            channel: null,
            query: "",
            count: 0,
            intention: 3,
        })
    } catch (error) {
        console.error(
            "[SystemEmojis] Failed to capture canonical Unicode order",
            error,
        )
    } finally {
        try {
            if (typeof temporaryUnpatch === "function") {
                temporaryUnpatch()
            }
        } catch {}
    }

    return captured
}

/* =========================================================
 * QUICK REACTIONS
 * ======================================================= */

function installQuickReactions(rn: any) {
    try {
        const beforeJSX =
            revenge.react.jsxRuntime.beforeJSX

        if (
            typeof beforeJSX !== "function" ||
            !rn?.Pressable ||
            !rn?.Text
        ) {
            console.log(
                "[SystemEmojis] Quick reactions skipped",
            )
            return
        }

        const unpatch = beforeJSX(
            rn.Pressable,
            (args: any[]) => {
                try {
                    const props = args?.[1]
                    const child = props?.children

                    if (
                        !props ||
                        !child ||
                        typeof child !== "object"
                    ) {
                        return args
                    }

                    const emoji = decodeAssetEmoji(
                        child?.props?.src,
                    )

                    if (!emoji) return args

                    const imageStyle = flattenStyle(
                        child?.props?.fastImageStyle,
                    )

                    if (
                        imageStyle.width !== 24 ||
                        imageStyle.height !== 24
                    ) {
                        return args
                    }

                    props.children = {
                        ...child,
                        type: rn.Text,
                        props: {
                            style: {
                                ...flattenStyle(
                                    child?.props
                                        ?.textEmojiStyle,
                                ),
                                textAlign: "center",
                                textAlignVertical:
                                    "center",
                            },
                            children: emoji,
                        },
                    }
                } catch {}

                return args
            },
        )

        addUnpatch(unpatch)
    } catch (error) {
        console.error(
            "[SystemEmojis] Quick reaction patch error",
            error,
        )
    }
}

/* =========================================================
 * AUTOCOMPLETE + FAVORITE/DETAILS
 * ======================================================= */

function installFastImageReplacement(
    rn: any,
    rt: any,
) {
    try {
        if (
            !rt?.jsx ||
            !rn?.Text ||
            typeof revenge.patcher?.before !== "function"
        ) {
            console.log(
                "[SystemEmojis] Autocomplete/details skipped",
            )
            return
        }

        const hook = (args: any[]) => {
            try {
                if (
                    getTypeName(args?.[0]) !==
                    "FastImageAndroid"
                ) {
                    return args
                }

                const props = args?.[1]
                const emoji = decodeAssetEmoji(
                    props?.source?.uri,
                )

                if (!emoji) return args

                const style = flattenStyle(
                    props?.style,
                )

                if (
                    style.width === 32 &&
                    style.height === 32
                ) {
                    args[0] = rn.Text
                    args[1] = {
                        style: {
                            width: 32,
                            height: 32,
                            fontSize: 27,
                            lineHeight: 32,
                            textAlign: "center",
                            textAlignVertical:
                                "center",
                        },
                        children: emoji,
                    }

                    return args
                }

                if (
                    style.width === 40 &&
                    style.height === 40
                ) {
                    args[0] = rn.Text
                    args[1] = {
                        style: {
                            width: 40,
                            height: 40,
                            marginRight:
                                style.marginRight,
                            fontSize: 34,
                            lineHeight: 40,
                            textAlign: "center",
                            textAlignVertical:
                                "center",
                        },
                        children: emoji,
                    }

                    return args
                }
            } catch (error) {
                console.error(
                    "[SystemEmojis] FastImage render error",
                    error,
                )
            }

            return args
        }

        addUnpatch(
            before(rt, "jsx", hook),
        )

        if (typeof rt.jsxs === "function") {
            addUnpatch(
                before(rt, "jsxs", hook),
            )
        }

    } catch (error) {
        console.error(
            "[SystemEmojis] Autocomplete/details patch error",
            error,
        )
    }
}

/* =========================================================
 * EMOJI PICKER SEARCH
 *
 * Virtualized mixed Unicode/custom results with native lock metadata.
 * ======================================================= */

function installPickerSearch(rn: any, rt: any) {
    try {
        if (
            !rt?.jsx || !rn?.Text || !rn?.Image || !rn?.View ||
            !rn?.Pressable || !rn?.FlatList ||
            typeof revenge.patcher?.before !== "function"
        ) {
            console.log("[SystemEmojis] Picker search skipped")
            return
        }

        const hook = (args: any[]) => {
            try {
                if (args?.[0] !== "EmojiPickerView") return args
                const pickerProps = args?.[1]
                const emojiData = pickerProps?.emojiData
                if (!emojiData?.hasSearchData || !Array.isArray(emojiData.data)) return args

                const data = emojiData.data
                const emojiSize = pickerProps.emojiSize ?? 33
                const emojiMargin = pickerProps.emojiMargin ?? 4
                const rowSize = emojiData.rowSize ?? 9
                // Leave unexpected layouts to Discord, including invalid row
                // sizes that could otherwise cause an infinite chunking loop.
                if (!Number.isInteger(rowSize) || rowSize <= 0 ||
                    !Number.isFinite(emojiSize) || emojiSize <= 0 ||
                    !Number.isFinite(emojiMargin) || emojiMargin < 0) return args

                const entries: Array<{ item: any; locked: boolean }> = []
                for (const section of data) {
                    if (section?.type !== 3 || !Array.isArray(section.emojis)) continue
                    for (const item of section.emojis) {
                        const id = item?.id
                        if (!getEmojiName(item)) continue
                        if (id == null && !getUnicodeSurrogate(item)) continue
                        if (id != null && hasSetLikeValue(section.emojisHidden, id)) continue
                        entries.push({
                            item,
                            locked: id != null && (
                                section.isSectionNitroLocked === true ||
                                item.disabled === true || item.available === false ||
                                hasSetLikeValue(section.emojisDisabled, id)
                            ),
                        })
                    }
                }

                const rows: Array<typeof entries> = []
                for (let i = 0; i < entries.length; i += rowSize) {
                    rows.push(entries.slice(i, i + rowSize))
                }
                const rowHeight = emojiSize + emojiMargin * 2
                const paddingTop = pickerProps.paddingTop ?? 4

                const renderItem = ({ item: row, index }: { item: typeof entries; index: number }) => {
                    const buttons = row.map(({ item, locked }, column) => {
                        const id = item.id
                        const name = getEmojiName(item)!
                        const visual = id == null
                            ? rt.jsx(rn.Text, {
                                style: {
                                    width: emojiSize, height: emojiSize,
                                    fontSize: Math.round(emojiSize * 0.82),
                                    lineHeight: emojiSize, textAlign: "center",
                                    textAlignVertical: "center",
                                },
                                children: getUnicodeSurrogate(item),
                            })
                            : rt.jsx(rn.Image, {
                                style: { width: emojiSize, height: emojiSize, resizeMode: "contain" },
                                source: {
                                    uri: `https://cdn.discordapp.com/emojis/${id}.${item.animated ? "gif" : "webp"}?size=96&quality=lossless`,
                                },
                            })
                        const nativeEvent: any = { emojiName: name }
                        if (id != null) nativeEvent.emojiId = String(id)
                        const event = { nativeEvent }

                        return rt.jsx(rn.Pressable, {
                            accessibilityLabel: name,
                            accessibilityState: locked ? { disabled: true } : undefined,
                            style: {
                                width: rowHeight, height: rowHeight,
                                alignItems: "center", justifyContent: "center",
                                opacity: locked ? 0.35 : 1,
                            },
                            // Let Discord/FakeNitro decide what a press does.
                            // A dimmed result must not swallow their callbacks.
                            onPress: () => pickerProps.onPressEmoji?.(event),
                            onLongPress: () => pickerProps.onLongPressEmoji?.(event),
                            children: visual,
                        }, `${id == null ? "unicode-" + name : "custom-" + id}-${index}-${column}`)
                    })
                    return rt.jsx(rn.View, {
                        style: { flexDirection: "row", alignItems: "center", height: rowHeight },
                        children: buttons,
                    })
                }

                args[0] = rn.FlatList
                args[1] = {
                    style: [pickerProps.style, { flex: 1 }],
                    data: rows,
                    renderItem,
                    keyExtractor: (_row: any, index: number) => `search-row-${index}`,
                    getItemLayout: (_rows: any, index: number) => ({
                        length: rowHeight, offset: paddingTop + rowHeight * index, index,
                    }),
                    initialNumToRender: 8,
                    maxToRenderPerBatch: 8,
                    windowSize: 5,
                    removeClippedSubviews: false,
                    contentContainerStyle: {
                        paddingHorizontal: 4, paddingTop,
                        paddingBottom: pickerProps.paddingBottom ?? 4,
                    },
                    keyboardShouldPersistTaps: "handled",
                }
            } catch (error) {
                console.error("[SystemEmojis] Picker search render error", error)
            }
            return args
        }

        addUnpatch(before(rt, "jsx", hook))
        if (typeof rt.jsxs === "function") addUnpatch(before(rt, "jsxs", hook))
    } catch (error) {
        console.error("[SystemEmojis] Picker search patch error", error)
    }
}


/* =========================================================
 * NORMAL NON-SEARCH EMOJI PICKER
 *
 * New path:
 * - Favorites / Frequently Used come from native type-3 data.
 * - Guild sections come from EmojiStore.getGuildEmoji(guildId).
 * - Built-in sections are sliced from Discord's canonical
 *   Unicode ordering using the native emojiCount values.
 *
 * The native picker is only replaced when all built-in counts
 * exactly match the captured canonical Unicode array. If any
 * prerequisite is missing, Discord's native picker is left
 * untouched instead of risking a broken picker.
 * ======================================================= */

function installPickerNormal(
    rn: any,
    rt: any,
) {
    let normalListRef: any = null
    let normalCategoryIndexes: Record<string, number> = {}
    let cachedEmojiStore: any = null
    let lastFallbackReason: string | null = null

    const noteFallback = (reason: string, details?: any) => {
        if (lastFallbackReason === reason) return
        lastFallbackReason = reason

        if (details === undefined) {
            console.warn(
                `[SystemEmojis] Normal picker fallback: ${reason}`,
            )
        } else {
            console.warn(
                `[SystemEmojis] Normal picker fallback: ${reason}`,
                details,
            )
        }
    }

    const resolveEmojiStore = () => {
        if (cachedEmojiStore) return cachedEmojiStore

        const found = getEmojiStore()
        if (found) cachedEmojiStore = found
        return found
    }

    const normalizeCategoryLabel = (value: any) =>
        typeof value === "string"
            ? value.trim().toLowerCase()
            : ""

    try {
        if (
            !rt?.jsx ||
            !rn?.Text ||
            !rn?.Image ||
            !rn?.View ||
            !rn?.Pressable ||
            !rn?.FlatList ||
            typeof revenge.patcher?.before !== "function"
        ) {
            console.log(
                "[SystemEmojis] Normal picker skipped",
            )
            return
        }

        const hook = (args: any[]) => {
            try {
                if (
                    args?.[0] !== "EmojiPickerView"
                ) {
                    return args
                }

                const pickerProps = args?.[1]
                const emojiData =
                    pickerProps?.emojiData

                if (
                    !emojiData ||
                    emojiData.hasSearchData === true
                ) {
                    return args
                }

                const data = emojiData?.data

                if (!Array.isArray(data)) {
                    noteFallback("emojiData.data is not an array")
                    return args
                }

                // Favorites/Frequently Used are type-3 sections and do not
                // necessarily carry their own disabled/Nitro metadata. Resolve
                // custom-emoji lock state against the guild sections that do.
                const isCustomEmojiLockedByPickerData = (
                    item: any,
                ): boolean => {
                    const id = item?.id
                    if (id == null) return false

                    if (
                        item?.disabled === true ||
                        item?.available === false ||
                        item?.emojiObject?.available === false
                    ) {
                        return true
                    }

                    const guildId =
                        item?.guildId ??
                        item?.guild_id ??
                        item?.emojiObject?.guildId ??
                        item?.emojiObject?.guild_id ??
                        null

                    for (const section of data) {
                        if (
                            hasSetLikeValue(
                                section?.emojisDisabled,
                                id,
                            )
                        ) {
                            return true
                        }

                        if (
                            guildId != null &&
                            section?.guildId != null &&
                            String(section.guildId) ===
                                String(guildId) &&
                            section?.isSectionNitroLocked === true
                        ) {
                            return true
                        }
                    }

                    return false
                }

                // EmojiStore may not be initialized yet when the plugin
                // starts after a full Discord/Revenge reload. Resolve it
                // lazily here, when the normal picker is actually rendering.
                const emojiStore = resolveEmojiStore()

                if (
                    !emojiStore ||
                    typeof emojiStore.getGuildEmoji !== "function"
                ) {
                    noteFallback("EmojiStore/getGuildEmoji unavailable")
                    return args
                }

                // The canonical Unicode array can occasionally fail to
                // capture during very early plugin startup. Retry lazily
                // when the normal picker actually renders instead of
                // permanently falling back to Discord's native Twemoji
                // picker for the rest of the session.
                if (!canonicalUnicode?.length) {
                    try {
                        const captured =
                            captureCanonicalUnicodeOrder(
                                emojiStore,
                            )

                        if (captured?.length) {
                            canonicalUnicode = captured
                            console.log(
                                `[SystemEmojis] Canonical Unicode order captured lazily (${captured.length})`,
                            )
                        }
                    } catch (error) {
                        console.error(
                            "[SystemEmojis] Lazy canonical Unicode capture failed",
                            error,
                        )
                    }
                }

                if (!canonicalUnicode?.length) {
                    noteFallback("canonical Unicode order unavailable")
                    return args
                }

                // Do not assume every guild-less type-7 section belongs to
                // Discord's built-in Unicode catalog. Other picker patches can
                // add or reshape neighboring sections. Find the contiguous
                // descriptor block whose counts exactly cover the canonical
                // Unicode catalog instead.
                const builtInCandidates =
                    data.filter(
                        (section: any) =>
                            section?.type === 7 &&
                            section?.guildId == null &&
                            typeof section?.emojiCount ===
                                "number" &&
                            section.emojiCount > 0,
                    )

                let builtInDescriptors: any[] | null = null
                let windowStart = 0
                let windowTotal = 0

                for (
                    let windowEnd = 0;
                    windowEnd < builtInCandidates.length;
                    windowEnd++
                ) {
                    windowTotal +=
                        builtInCandidates[windowEnd].emojiCount

                    while (
                        windowStart <= windowEnd &&
                        windowTotal > canonicalUnicode.length
                    ) {
                        windowTotal -=
                            builtInCandidates[windowStart].emojiCount
                        windowStart++
                    }

                    if (
                        windowTotal === canonicalUnicode.length
                    ) {
                        builtInDescriptors =
                            builtInCandidates.slice(
                                windowStart,
                                windowEnd + 1,
                            )
                    }
                }

                if (!builtInDescriptors?.length) {
                    noteFallback(
                        "could not identify canonical Unicode section block",
                        {
                            canonical: canonicalUnicode.length,
                            candidates: builtInCandidates.map(
                                (section: any) => ({
                                    title: section?.title ?? null,
                                    emojiCount: section?.emojiCount ?? null,
                                }),
                            ),
                        },
                    )
                    return args
                }

                const builtInDescriptorSet =
                    new Set(builtInDescriptors)

                const emojiSize =
                    pickerProps?.emojiSize ?? 33
                const emojiMargin =
                    pickerProps?.emojiMargin ?? 4
                const rowSize =
                    emojiData?.rowSize ?? 9
                const headerHeight = 32
                const emojiRowHeight =
                    emojiSize + emojiMargin * 2

                type PickerListRow =
                    | {
                          kind: "header"
                          key: string
                          title: string
                      }
                    | {
                          kind: "emojiRow"
                          key: string
                          items: any[]
                          disabledSet?: any
                          sectionLocked?: boolean
                      }

                const listRows: PickerListRow[] = []
                let sectionNumber = 0
                let pendingHeader: string | null =
                    null
                let unicodeOffset = 0

                const addSection = (
                    title: string,
                    items: any[],
                    disabledSet?: any,
                    hiddenSet?: any,
                    sectionLocked = false,
                ) => {
                    if (!Array.isArray(items)) return

                    const visibleItems =
                        hiddenSet == null
                            ? items
                            : items.filter(
                                  (item: any) =>
                                      !hasSetLikeValue(
                                          hiddenSet,
                                          item?.id,
                                      ),
                              )

                    if (!visibleItems.length) return

                    const sectionKey =
                        `section-${sectionNumber++}-${title}`

                    listRows.push({
                        kind: "header",
                        key: `${sectionKey}-header`,
                        title,
                    })

                    for (
                        let i = 0;
                        i < visibleItems.length;
                        i += rowSize
                    ) {
                        listRows.push({
                            kind: "emojiRow",
                            key: `${sectionKey}-row-${i}`,
                            items: visibleItems.slice(
                                i,
                                i + rowSize,
                            ),
                            disabledSet,
                            sectionLocked,
                        })
                    }
                }

                for (
                    let index = 0;
                    index < data.length;
                    index++
                ) {
                    const section = data[index]

                    if (section?.type === 1) {
                        pendingHeader =
                            section?.title ??
                            section?.label ??
                            section?.name ??
                            null
                        continue
                    }

                    if (
                        section?.type === 3 &&
                        Array.isArray(section?.emojis)
                    ) {
                        const title =
                            pendingHeader ??
                            section?.title ??
                            section?.label ??
                            "Emoji"

                        addSection(
                            String(title),
                            section.emojis,
                        )

                        pendingHeader = null
                        continue
                    }

                    if (section?.type !== 7) {
                        continue
                    }

                    if (section?.guildId != null) {
                        let guildEmoji: any[] = []

                        try {
                            const result =
                                emojiStore.getGuildEmoji(
                                    String(
                                        section.guildId,
                                    ),
                                )

                            if (Array.isArray(result)) {
                                guildEmoji = result
                            }
                        } catch {}

                        addSection(
                            String(
                                section?.title ??
                                    "Server Emoji",
                            ),
                            guildEmoji,
                            section?.emojisDisabled,
                            section?.emojisHidden,
                            section?.isSectionNitroLocked === true,
                        )

                        continue
                    }

                    if (
                        builtInDescriptorSet.has(section)
                    ) {
                        const count = section.emojiCount
                        const builtInEmoji =
                            canonicalUnicode.slice(
                                unicodeOffset,
                                unicodeOffset + count,
                            )

                        unicodeOffset += count

                        addSection(
                            String(
                                section?.title ??
                                    "Emoji",
                            ),
                            builtInEmoji,
                            section?.emojisDisabled,
                            section?.emojisHidden,
                            section?.isSectionNitroLocked === true,
                        )

                        continue
                    }

                    // Preserve any non-canonical guild-less type-7 section
                    // that already carries concrete emoji objects instead of
                    // misclassifying it as part of the Unicode catalog.
                    if (Array.isArray(section?.emojis)) {
                        addSection(
                            String(
                                section?.title ??
                                    "Emoji",
                            ),
                            section.emojis,
                            section?.emojisDisabled,
                            section?.emojisHidden,
                            section?.isSectionNitroLocked === true,
                        )
                    }
                }

                if (
                    unicodeOffset !==
                    canonicalUnicode.length
                ) {
                    noteFallback(
                        "Unicode slice mismatch",
                        {
                            used: unicodeOffset,
                            canonical: canonicalUnicode.length,
                        },
                    )
                    return args
                }

                const renderEmoji = (
                    item: any,
                    key: string,
                    disabledSet?: any,
                    sectionLocked = false,
                ) => {
                    const id = item?.id
                    const name = getEmojiName(item)
                    const surrogate =
                        getUnicodeSurrogate(item)

                    if (!name) return null

                    let visual: any = null

                    if (
                        id == null &&
                        surrogate
                    ) {
                        visual = rt.jsx(
                            rn.Text,
                            {
                                style: {
                                    width: emojiSize,
                                    height: emojiSize,
                                    fontSize: Math.round(
                                        emojiSize * 0.82,
                                    ),
                                    lineHeight: emojiSize,
                                    textAlign: "center",
                                    textAlignVertical:
                                        "center",
                                },
                                children: surrogate,
                            },
                        )
                    } else if (id != null) {
                        const ext = item?.animated
                            ? "gif"
                            : "webp"

                        visual = rt.jsx(
                            rn.Image,
                            {
                                style: {
                                    width: emojiSize,
                                    height: emojiSize,
                                    resizeMode: "contain",
                                },
                                source: {
                                    uri:
                                        `https://cdn.discordapp.com/emojis/${id}.${ext}` +
                                        `?size=96&quality=lossless`,
                                },
                            },
                        )
                    }

                    if (!visual) return null

                    const locked =
                        sectionLocked === true ||
                        (
                            id != null &&
                            hasSetLikeValue(
                                disabledSet,
                                id,
                            )
                        ) ||
                        isCustomEmojiLockedByPickerData(item)

                    const nativeEvent: any = {
                        emojiName: name,
                    }

                    if (id != null) {
                        nativeEvent.emojiId =
                            String(id)
                    }

                    const event = {
                        nativeEvent,
                    }

                    return rt.jsx(
                        rn.Pressable,
                        {
                            accessibilityState: locked
                                ? { disabled: true }
                                : undefined,
                            style: {
                                width:
                                    emojiSize +
                                    emojiMargin * 2,
                                height:
                                    emojiSize +
                                    emojiMargin * 2,
                                alignItems: "center",
                                justifyContent:
                                    "center",
                                opacity: locked
                                    ? 0.35
                                    : 1,
                            },
                            onPress: () => {
                                try {
                                    pickerProps?.onPressEmoji?.(
                                        event,
                                    )
                                } catch {}
                            },
                            onLongPress: () => {
                                try {
                                    pickerProps?.onLongPressEmoji?.(
                                        event,
                                    )
                                } catch {}
                            },
                            children: visual,
                        },
                        key,
                    )
                }

                const renderItem = ({
                    item,
                }: {
                    item: PickerListRow
                }) => {
                    try {
                        if (item.kind === "header") {
                            return rt.jsx(
                                rn.Text,
                                {
                                    style: {
                                        height: headerHeight,
                                        paddingHorizontal: 8,
                                        paddingTop: 8,
                                        paddingBottom: 4,
                                        fontSize: 14,
                                        lineHeight: 20,
                                        fontWeight: "600",
                                        color: "#dbdee1",
                                    },
                                    children: item.title,
                                },
                                item.key,
                            )
                        }

                        const buttons: any[] = []

                        for (
                            let i = 0;
                            i < item.items.length;
                            i++
                        ) {
                            const emoji = renderEmoji(
                                item.items[i],
                                `${item.key}-emoji-${i}`,
                                item.disabledSet,
                                item.sectionLocked,
                            )

                            if (emoji) {
                                buttons.push(emoji)
                            }
                        }

                        return rt.jsx(
                            rn.View,
                            {
                                style: {
                                    height:
                                        emojiRowHeight,
                                    flexDirection: "row",
                                    alignItems: "center",
                                },
                                children: buttons,
                            },
                            item.key,
                        )
                    } catch (error) {
                        console.error(
                            "[SystemEmojis] Normal picker row render error",
                            error,
                        )
                        return null
                    }
                }

                const itemLayouts: Array<{
                    length: number
                    offset: number
                    index: number
                }> = []

                const categoryIndexes: Record<
                    string,
                    number
                > = {}

                let runningOffset = 0

                for (
                    let i = 0;
                    i < listRows.length;
                    i++
                ) {
                    const row = listRows[i]
                    const length =
                        row.kind === "header"
                            ? headerHeight
                            : emojiRowHeight

                    itemLayouts.push({
                        length,
                        offset: runningOffset,
                        index: i,
                    })

                    runningOffset += length

                    if (row.kind === "header") {
                        const label =
                            normalizeCategoryLabel(
                                row.title,
                            )

                        if (
                            label &&
                            categoryIndexes[label] == null
                        ) {
                            categoryIndexes[label] = i
                        }
                    }
                }

                normalCategoryIndexes =
                    categoryIndexes
                lastFallbackReason = null

                args[0] = rn.FlatList
                args[1] = {
                    style: {
                        flex: 1,
                    },
                    contentContainerStyle: {
                        paddingHorizontal: 4,
                        paddingBottom: 12,
                    },
                    data: listRows,
                    ref: (instance: any) => {
                        normalListRef = instance
                    },
                    getItemLayout: (
                        _data: any,
                        index: number,
                    ) =>
                        itemLayouts[index] ?? {
                            length: emojiRowHeight,
                            offset:
                                index * emojiRowHeight,
                            index,
                        },
                    onScrollToIndexFailed: (
                        info: any,
                    ) => {
                        try {
                            const layout =
                                itemLayouts[info?.index]

                            if (
                                normalListRef &&
                                layout &&
                                typeof normalListRef
                                    .scrollToOffset ===
                                    "function"
                            ) {
                                normalListRef.scrollToOffset({
                                    offset: layout.offset,
                                    animated: false,
                                })
                            }
                        } catch {}
                    },
                    renderItem,
                    keyExtractor: (
                        item: PickerListRow,
                    ) => item.key,
                    keyboardShouldPersistTaps:
                        "handled",
                    initialNumToRender: 18,
                    maxToRenderPerBatch: 24,
                    windowSize: 9,
                    removeClippedSubviews: true,
                }
            } catch (error) {
                console.error(
                    "[SystemEmojis] Normal picker render error",
                    error,
                )
            }

            return args
        }

        addUnpatch(
            before(rt, "jsx", hook),
        )

        if (typeof rt.jsxs === "function") {
            addUnpatch(
                before(rt, "jsxs", hook),
            )
        }

        try {
            const beforeJSX =
                revenge.react.jsxRuntime.beforeJSX

            if (
                typeof beforeJSX === "function" &&
                rn?.Pressable
            ) {
                addUnpatch(
                    beforeJSX(
                        rn.Pressable,
                        (args: any[]) => {
                            try {
                                const props = args?.[1]
                                const label =
                                    normalizeCategoryLabel(
                                        props?.accessibilityLabel,
                                    )
                                const index =
                                    normalCategoryIndexes[label]

                                if (
                                    !label ||
                                    typeof index !== "number" ||
                                    !normalListRef ||
                                    typeof props?.onPress !==
                                        "function"
                                ) {
                                    return args
                                }

                                if (
                                    props.__systemEmojiCategoryNav
                                ) {
                                    return args
                                }

                                props.__systemEmojiCategoryNav =
                                    true

                                const originalOnPress =
                                    props.onPress

                                props.onPress = (
                                    ...pressArgs: any[]
                                ) => {
                                    try {
                                        if (
                                            normalListRef &&
                                            typeof normalListRef
                                                .scrollToIndex ===
                                                "function"
                                        ) {
                                            normalListRef.scrollToIndex({
                                                index,
                                                animated: false,
                                                viewPosition: 0,
                                            })
                                            return
                                        }
                                    } catch {}

                                    try {
                                        return originalOnPress(
                                            ...pressArgs,
                                        )
                                    } catch {}
                                }
                            } catch {}

                            return args
                        },
                    ),
                )
            }
        } catch (error) {
            console.error(
                "[SystemEmojis] Normal picker category navigation patch error",
                error,
            )
        }

    } catch (error) {
        console.error(
            "[SystemEmojis] Normal picker patch error",
            error,
        )
    }
}

/* =========================================================
 * PLUGIN
 * ======================================================= */

export default plugin({
    start() {
        cleanupAll()
        canonicalUnicode = null
        installLogNoiseFilter()

        installMessagePatch()

        try {
            const rn = getRN()
            const rt = getRawJSXRuntime()
            const emojiStore = getEmojiStore()

            if (!rn) {
                console.error(
                    "[SystemEmojis] React Native module not found",
                )
                return
            }

            if (!rt) {
                console.error(
                    "[SystemEmojis] Raw JSX runtime not found",
                )
                return
            }

            installQuickReactions(rn)

            installFastImageReplacement(
                rn,
                rt,
            )

            installPickerSearch(
                rn,
                rt,
            )

            if (emojiStore) {
                canonicalUnicode =
                    captureCanonicalUnicodeOrder(
                        emojiStore,
                    )
            } else {
                console.error(
                    "[SystemEmojis] EmojiStore not found",
                )
            }

            // Always install the normal-picker hook. EmojiStore itself may
            // not exist yet during cold startup, so the hook resolves it
            // lazily when EmojiPickerView actually renders.
            installPickerNormal(
                rn,
                rt,
            )

            console.log(
                `[SystemEmojis] Started successfully with ${unpatches.length} patch(es)`,
            )
        } catch (error) {
            console.error(
                "[SystemEmojis] UI startup error",
                error,
            )
        }
    },

    stop() {
        cleanupAll()
        canonicalUnicode = null
    },
})
