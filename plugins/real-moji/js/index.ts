import { lookupModules } from '@revenge-mod/modules/finders'
import { withProps } from '@revenge-mod/modules/finders/filters'
import { getNativeModule } from '@revenge-mod/modules/native'
import { before } from '@revenge-mod/patcher'

interface EmojiStore {
    getCustomEmojiById(id: string): { name?: string; animated?: boolean } | undefined
}
interface ChatModule {
    updateRows(...args: any[]): unknown
}

function parseEmojiUrl(value: unknown) {
    if (typeof value !== 'string') return null
    const match = /^https:\/\/cdn\.discordapp\.com\/emojis\/(\d+)\.(png|webp|gif|jpe?g)(?:[?#].*)?$/i.exec(value)
    if (!match) return null
    return { id: match[1], extension: match[2].toLowerCase(), url: new URL(value) }
}

function whitespace(node: any): boolean {
    return node?.type === 'text' && typeof node.content === 'string' && node.content.trim() === ''
}

function trimContent(content: any[]) {
    while (content.length && whitespace(content[0])) content.shift()
    while (content.length && whitespace(content[content.length - 1])) content.pop()
    if (content[0]?.type === 'text' && typeof content[0].content === 'string') content[0].content = content[0].content.trimStart()
    const last = content[content.length - 1]
    if (last?.type === 'text' && typeof last.content === 'string') last.content = last.content.trimEnd()
}

export default plugin({
    start({ cleanup }) {
        const chat = getNativeModule<ChatModule>('NativeChatModule')
        if (!chat || typeof chat.updateRows !== 'function') throw new Error('NativeChatModule.updateRows not found')
        let store: EmojiStore | undefined
        cleanup(() => { store = undefined })

        const createEmoji = (value: string, jumbo: boolean) => {
            const parsed = parseEmojiUrl(value)
            if (!parsed) return null
            store ??= [...lookupModules(withProps<EmojiStore>('getCustomEmojiById'))][0]?.[0]
            const emoji = store?.getCustomEmojiById(parsed.id)
            const animated = parsed.extension === 'gif' || parsed.url.searchParams.get('animated') === 'true' || emoji?.animated === true
            const src = `https://cdn.discordapp.com/emojis/${parsed.id}.${animated ? 'gif' : 'webp'}?size=128`
            return {
                type: 'customEmoji', id: parsed.id,
                alt: emoji?.name ?? parsed.url.searchParams.get('name') ?? '<realmoji>',
                src, frozenSrc: src.replace('.gif', '.webp'),
                jumboable: jumbo ? true : undefined,
            }
        }

        const transform = (message: any) => {
            if (!Array.isArray(message?.content)) return null
            let content = message.content.map((node: any) => ({ ...node }))
            const convertedIds = new Set<string>()
            const embedUrl = (embed: any) => embed?.url ?? embed?.image?.url
            if (content.length === 0 && Array.isArray(message.embeds)) {
                for (const embed of message.embeds) {
                    if (embed?.type !== 'image') continue
                    const converted = createEmoji(embedUrl(embed), true)
                    if (!converted) continue
                    if (content.length) content.push({ type: 'text', content: ' ', jumboable: true })
                    content.push(converted)
                    convertedIds.add(converted.id)
                }
            } else {
                const meaningful = content.filter((node: any) => !whitespace(node))
                const jumbo = meaningful.length > 0 && meaningful.every((node: any) => node?.type === 'link' && parseEmojiUrl(node.target))
                content = content.map((node: any) => {
                    if (node?.type !== 'link') return node
                    const converted = createEmoji(node.target, jumbo)
                    if (!converted) return node
                    convertedIds.add(converted.id)
                    return converted
                })
                if (convertedIds.size) trimContent(content)
            }
            if (!convertedIds.size) return null

            const result = { ...message, content }
            if (Array.isArray(message.embeds)) {
                result.embeds = message.embeds.filter((embed: any) => {
                    if (embed?.type !== 'image') return true
                    const parsed = parseEmojiUrl(embedUrl(embed))
                    return !parsed || !convertedIds.has(parsed.id)
                })
            }
            const empty = (value: unknown) => value == null || (Array.isArray(value) && value.length === 0)
            if (empty(result.attachments) && empty(result.embeds)) {
                result.useAttachmentGridLayout = false
                result.useAttachmentUploadPreview = false
            }
            return result
        }

        cleanup(before(chat, 'updateRows', args => {
            if (typeof args[1] !== 'string') return args
            try {
                const rows = JSON.parse(args[1])
                if (!Array.isArray(rows)) return args
                let changed = false
                for (const row of rows) {
                    if (row?.type !== 1 || !row.message) continue
                    try {
                        const message = transform(row.message)
                        if (message) { row.message = message; changed = true }
                    } catch (error) {
                        console.error('[RealMoji] Failed to process row', error)
                    }
                }
                if (changed) args[1] = JSON.stringify(rows)
            } catch (error) {
                console.error('[RealMoji] updateRows error', error)
            }
            return args
        }))
    },
})
