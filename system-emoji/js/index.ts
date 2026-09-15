import { before } from '@revenge-mod/patcher'

type ContentRow = {
    type: string
    content?: string | ContentRow[]
    items?: ContentRow[]
    surrogate?: string
    jumboable?: boolean
    [key: string]: any
}

type MessageRow = {
    type: number
    message?: {
        content?: ContentRow[]
        [key: string]: any
    }
    [key: string]: any
}

/**
 * Faithful port of Nexpid's original iterate() function.
 *
 * - Converts normal Discord emoji rows into text rows, so they use
 *   the system emoji font.
 * - Preserves customEmoji rows.
 * - Preserves Discord's jumbo emoji behavior using jumboable.
 * - Recursively handles nested content/items arrays.
 */
function iterate(rows: ContentRow[]): ContentRow[] {
    const content: ContentRow[] = []

    let header: ContentRow | undefined

    for (const original of rows) {
        let row = original

        // Replace Discord's Twemoji emoji node with ordinary text
        // containing the Unicode surrogate.
        if (row.type === 'emoji') {
            row = {
                type: 'text',
                content: row.surrogate ?? '',
            }
        }

        // Recursively process styled/nested content.
        if ('content' in row && Array.isArray(row.content)) {
            row.content = iterate(row.content)
        }

        if ('items' in row && Array.isArray(row.items)) {
            row.items = iterate(row.items)
        }

        // Start a jumbo header when Discord says this row is jumboable.
        if (
            'jumboable' in original &&
            original.jumboable &&
            !header
        ) {
            header = {
                type: 'heading',
                level: 1,
                content: [],
            }
        }

        // A non-jumbo emoji/custom emoji ends the jumbo group.
        if (
            (original.type === 'emoji' ||
                original.type === 'customEmoji') &&
            !original.jumboable &&
            header
        ) {
            content.push(header)
            header = undefined
        }

        if (header) {
            ;(header.content as ContentRow[]).push(row)
        } else {
            content.push(row)
        }
    }

    // Flush an unfinished jumbo group.
    if (header) {
        content.push(header)
    }

    return content
}

export default plugin({
    start({ cleanup }) {
        const chatModule =
            globalThis.nativeModuleProxy?.NativeChatModule

        if (!chatModule?.updateRows) {
            console.log(
                '[use-system-emojis] NativeChatModule.updateRows not found'
            )
            return
        }

        cleanup(
            before(chatModule, 'updateRows', (args) => {
                try {
                    const rows = JSON.parse(args[1]) as MessageRow[]

                    for (const row of rows) {
                        if (
                            row.type === 1 &&
                            row.message?.content
                        ) {
                            row.message.content = iterate(
                                row.message.content
                            )
                        }
                    }

                    args[1] = JSON.stringify(rows)
                } catch (error) {
                    console.error(
                        '[use-system-emojis] Failed to process updateRows:',
                        error
                    )
                }

                return args
            })
        )

        console.log(
            '[use-system-emojis] NativeChatModule.updateRows patched'
        )
    },
})