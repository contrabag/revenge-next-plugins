const { before } = revenge.patcher

let unpatches: Array<() => void> = []
let restoreLogNoise: (() => void) | null = null

const menuArtwork = new Map<string, string>()
let nextArtworkRetry = 0
function nativeMenuArtwork(emoji: string, size: number, rn: any): string | null {
    const density = Number(rn?.PixelRatio?.get?.()) || 1
    const pixels = Math.max(16, Math.min(256, Math.ceil(size * density)))
    const key = `${emoji}:${pixels}`
    const cached = menuArtwork.get(key)
    if (cached) return cached
    if (Date.now() < nextArtworkRetry) return null
    try {
        const uri = (revenge.modules?.native as any)?.callNativeMethodSync?.(
            "contrabag.systememoji.artwork", [emoji, pixels],
        )
        if (typeof uri === "string" && uri.startsWith("data:image/png;base64,")) {
            if (menuArtwork.size >= 256) menuArtwork.delete(menuArtwork.keys().next().value!)
            menuArtwork.set(key, uri)
            return uri
        }
    } catch {}
    nextArtworkRetry = Date.now() + 1000
    return null
}

function cleanupAll() {
    menuArtwork.clear()
    nextArtworkRetry = 0
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

function installLogNoiseFilter() {
    if (restoreLogNoise) return

    try {
        const consoleObject = globalThis.console as any
        const originalWarn = consoleObject.warn
        const originalLog = consoleObject.log
        const originalInfo = consoleObject.info

        const shouldHide = (args: any[]) => {
            if (args.some(value => typeof value === "string" &&
                value.includes("Couldn't find the scrollable node handle id!"))) return true
            const first = args?.[0]
            if (typeof first !== "string") return false

            return (
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

                    const artwork = nativeMenuArtwork(emoji, 24, rn)
                    if (artwork) {
                        args[1] = { ...props, children: {
                            ...child, props: { ...child.props, src: artwork },
                        } }
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

                if ((style.width === 32 || style.width === 40) && style.height === style.width) {
                    const artwork = nativeMenuArtwork(emoji, style.width, rn)
                    if (artwork) {
                        args[1] = { ...props, source: { ...props.source, uri: artwork } }
                        return args
                    }
                }

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

export default plugin({
    start() {
        cleanupAll()
        installLogNoiseFilter()
        try {
            const rn = getRN()
            const rt = getRawJSXRuntime()
            if (!rn || !rt) {
                console.error("[SystemEmojis] Menu modules unavailable; Discord artwork retained")
                return
            }
            installQuickReactions(rn)
            installFastImageReplacement(rn, rt)
        } catch (error) {
            console.error("[SystemEmojis] Menu startup error", error)
        }
    },
    stop() { cleanupAll() },
})
