import { callNativeMethodSync } from '@revenge-mod/modules/native'
import { before, instead } from '@revenge-mod/patcher'
import { ReactNative, ReactJSXRuntime } from '@revenge-mod/react'
import { beforeJSX } from '@revenge-mod/react/jsx-runtime'
import type { PluginApi } from '@revenge-mod/plugins/types'
import type { ImageStyle, StyleProp } from 'react-native'

declare module '@revenge-mod/modules/native' {
    interface NativeMethods {
        'contrabag.systememoji.artwork': [[emoji: string, pixels: number], string | null]
    }
}

function decodeAssetEmoji(uri: unknown): string | null {
    if (typeof uri !== 'string') return null
    const match = /^asset:\/emoji-([0-9a-f-]+)\.png$/i.exec(uri)
    if (!match) return null
    try {
        return String.fromCodePoint(...match[1].split('-').map(part => Number.parseInt(part, 16)))
    } catch {
        return null
    }
}

function imageSize(style: StyleProp<ImageStyle>, sizes: readonly number[]): number | null {
    const flat = ReactNative.StyleSheet.flatten(style)
    const size = flat?.width
    return typeof size === 'number' && flat?.height === size && sizes.includes(size) ? size : null
}

export default plugin({
    start({ cleanup, plugin: owner }: PluginApi) {
        const artwork = new Map<string, string>()
        let retryAt = 0
        let reportedFailure = false
        const report = (error: unknown) => {
            if (!reportedFailure) {
                reportedFailure = true
                owner.reportError(error)
            }
        }
        cleanup(() => artwork.clear())

        const render = (emoji: string, size: number): string | null => {
            const pixels = Math.max(16, Math.min(256, Math.ceil(size * ReactNative.PixelRatio.get())))
            const key = `${emoji}:${pixels}`
            const cached = artwork.get(key)
            if (cached) return cached
            if (Date.now() < retryAt) return null
            try {
                const uri = callNativeMethodSync('contrabag.systememoji.artwork', [emoji, pixels])
                if (typeof uri === 'string' && uri.startsWith('data:image/png;base64,')) {
                    if (artwork.size >= 256) artwork.delete(artwork.keys().next().value!)
                    artwork.set(key, uri)
                    return uri
                }
                report(new Error('System Emoji native artwork is unavailable'))
            } catch (error) {
                report(error)
            }
            retryAt = Date.now() + 1000
            return null
        }

        cleanup(beforeJSX(ReactNative.Pressable, args => {
            try {
                const props = args[1]
                const child = props?.children as any
                const emoji = decodeAssetEmoji(child?.props?.src)
                if (!emoji || !imageSize(child.props.fastImageStyle, [24])) return args
                const uri = render(emoji, 24)
                if (uri) args[1] = {
                    ...props,
                    children: { ...child, props: { ...child.props, src: uri } },
                }
            } catch (error) {
                report(error)
            }
            return args
        }))

        const replaceMenuImage = (args: Parameters<typeof ReactJSXRuntime.jsx>) => {
            try {
                const type = args[0] as any
                if ((typeof type === 'string' ? type : type?.displayName || type?.name) !== 'FastImageAndroid') return args
                const props = args[1] as any
                const emoji = decodeAssetEmoji(props?.source?.uri)
                if (!emoji) return args
                const size = imageSize(props.style, [32, 40])
                if (!size) return args
                const uri = render(emoji, size)
                if (uri) args[1] = { ...props, source: { ...props.source, uri } }
            } catch (error) {
                report(error)
            }
            return args
        }
        cleanup(before(ReactJSXRuntime, 'jsx', replaceMenuImage))
        cleanup(before(ReactJSXRuntime, 'jsxs', replaceMenuImage))

        for (const method of ['warn', 'log', 'info'] as const) {
            cleanup(instead(console, method, function (args, original) {
                if (args.some(value => typeof value === 'string' && value.includes("Couldn't find the scrollable node handle id!"))) return
                return Reflect.apply(original, this, args)
            }))
        }
    },
})
