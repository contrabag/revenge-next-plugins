const { before } = revenge.patcher

const NativeChatModule =
    (globalThis as any).nativeModuleProxy?.NativeChatModule

let unpatch: (() => void) | undefined

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
        if (!header) {
            return
        }

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
            "content" in row &&
            Array.isArray(row.content)
        ) {
            row.content =
                iterate(row.content)
        }

        if (
            "items" in row &&
            Array.isArray(row.items)
        ) {
            row.items =
                iterate(row.items)
        }

        if (
            original?.type ===
            "customEmoji"
        ) {
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

export default plugin({
    start() {
        if (
            !NativeChatModule?.updateRows
        ) {
            throw new Error(
                "NativeChatModule.updateRows not found",
            )
        }

        unpatch = before(
            NativeChatModule,
            "updateRows",
            (args) => {
                try {
                    if (
                        typeof args[1] !==
                        "string"
                    ) {
                        return args
                    }

                    const rows =
                        JSON.parse(args[1])

                    if (!Array.isArray(rows)) {
                        return args
                    }

                    for (const row of rows) {
                        try {
                            if (
                                row?.type !== 1 ||
                                !Array.isArray(
                                    row?.message
                                        ?.content,
                                )
                            ) {
                                continue
                            }

                            row.message.content =
                                iterate(
                                    row.message
                                        .content,
                                )
                        } catch (error) {
                            console.error(
                                "[SystemEmojis] Failed to process row",
                                error,
                            )
                        }
                    }

                    args[1] =
                        JSON.stringify(rows)
                } catch (error) {
                    console.error(
                        "[SystemEmojis] updateRows error",
                        error,
                    )
                }

                return args
            },
        )
    },

    stop() {
        unpatch?.()
        unpatch = undefined
    },
})