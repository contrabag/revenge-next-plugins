const { lookupModules } = revenge.modules.finders
const { withName, withProps } = revenge.modules.finders.filters
const { before, after } = revenge.patcher

const emojiRegex =
    /https:\/\/cdn\.discordapp\.com\/emojis\/(\d+)\.\w+/

const RowManager =
    [...lookupModules(withName("RowManager"))][0]?.[0]

const EmojiStore =
    [...lookupModules(withProps("getCustomEmojiById"))][0]?.[0]

const patches: (() => void)[] = []

const transformedMessages = new Set<string>()

export default plugin({
    start() {
        if (!RowManager?.prototype?.generate) {
            throw new Error("RowManager.generate not found")
        }

        if (!EmojiStore?.getCustomEmojiById) {
            throw new Error(
                "EmojiStore.getCustomEmojiById not found",
            )
        }

        patches.push(
            before(
                RowManager.prototype,
                "generate",
                (args) => {
                    const data = args[0]

                    if (data?.rowType !== 1) {
                        return args
                    }

                    let content = data?.message?.content

                    if (
                        typeof content !== "string" ||
                        !content.length
                    ) {
                        return args
                    }

                    const matchIndex =
                        content.match(emojiRegex)?.index

                    if (matchIndex === undefined) {
                        return args
                    }

                    const emojis = content
                        .slice(matchIndex)
                        .trim()
                        .split("\n")

                    if (
                        !emojis.every((emoji: string) =>
                            emojiRegex.test(emoji),
                        )
                    ) {
                        return args
                    }

                    content = content.slice(
                        0,
                        matchIndex,
                    )

                    while (
                        content.indexOf("  ") !== -1
                    ) {
                        const emoji = emojis.shift()

                        if (!emoji) break

                        content = content.replace(
                            "  ",
                            ` ${emoji} `,
                        )
                    }

                    content = content.trim()

                    if (emojis.length) {
                        content += ` ${emojis.join(" ")}`
                    }

                    const embeds = data.message.embeds

                    if (Array.isArray(embeds)) {
                        for (
                            let i = 0;
                            i < embeds.length;
                            i++
                        ) {
                            const embed = embeds[i]

                            if (
                                embed?.type === "image" &&
                                typeof embed?.url ===
                                    "string" &&
                                emojiRegex.test(embed.url)
                            ) {
                                embeds.splice(i--, 1)
                            }
                        }
                    }

                    data.message.content = content

                    if (data.message.id) {
                        transformedMessages.add(
                            data.message.id,
                        )
                    }

                    return args
                },
            ),
        )

        patches.push(
            after(
                RowManager.prototype,
                "generate",
                (row) => {
                    const message = row?.message

                    if (!message) {
                        return row
                    }

                    if (
                        message.id &&
                        !transformedMessages.has(
                            message.id,
                        )
                    ) {
                        return row
                    }

                    const content = message.content

                    if (!Array.isArray(content)) {
                        return row
                    }

                    const hasEmojiLinks =
                        content.some(
                            (element: any) =>
                                element?.type === "link" &&
                                typeof element?.target ===
                                    "string" &&
                                emojiRegex.test(
                                    element.target,
                                ),
                        )

                    if (!hasEmojiLinks) {
                        return row
                    }

                    const jumbo = content.every(
                        (element: any) =>
                            (element?.type === "link" &&
                                typeof element?.target ===
                                    "string" &&
                                emojiRegex.test(
                                    element.target,
                                )) ||
                            (element?.type === "text" &&
                                element?.content === " "),
                    )

                    for (
                        let i = 0;
                        i < content.length;
                        i++
                    ) {
                        const element = content[i]

                        if (
                            element?.type !== "link" ||
                            typeof element?.target !==
                                "string"
                        ) {
                            continue
                        }

                        const match =
                            element.target.match(
                                emojiRegex,
                            )

                        if (!match) {
                            continue
                        }

                        const id = match[1]

                        const isAnimated =
                            element.target.includes(
                                "animated=true",
                            )

                        const coreUrl =
                            `https://cdn.discordapp.com/emojis/${id}.` +
                            (isAnimated
                                ? "gif"
                                : "webp")

                        const url =
                            `${coreUrl}?size=128`

                        const emoji =
                            EmojiStore.getCustomEmojiById(
                                id,
                            )

                        content[i] = {
                            type: "customEmoji",
                            id,
                            alt:
                                emoji?.name ??
                                "<realmoji>",
                            src: url,
                            frozenSrc: url.replace(
                                ".gif",
                                ".webp",
                            ),
                            jumboable: jumbo
                                ? true
                                : undefined,
                        }
                    }

                    return row
                },
            ),
        )
    },

    stop() {
        for (const unpatch of patches.splice(0)) {
            unpatch()
        }

        transformedMessages.clear()
    },
})