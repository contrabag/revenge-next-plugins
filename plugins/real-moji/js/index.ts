const { before } = revenge.patcher

const { lookupModules } =
    revenge.modules.finders

const { withProps } =
    revenge.modules.finders.filters

const emojiRegex =
    /https:\/\/cdn\.discordapp\.com\/emojis\/(\d+)\.(\w+)/

const NativeChatModule =
    (globalThis as any)
        .nativeModuleProxy
        ?.NativeChatModule

let unpatch:
    | (() => void)
    | undefined

let cachedEmojiStore: any

function getEmojiStore() {
    if (
        cachedEmojiStore
            ?.getCustomEmojiById
    ) {
        return cachedEmojiStore
    }

    try {
        const found =
            [...lookupModules(
                withProps(
                    "getCustomEmojiById",
                ),
            )][0]?.[0]

        if (
            found
                ?.getCustomEmojiById
        ) {
            cachedEmojiStore =
                found

            return found
        }
    } catch {}

    return undefined
}

function getEmojiInfo(
    url: string,
) {
    const match =
        url.match(emojiRegex)

    if (!match) {
        return
    }

    const id =
        match[1]

    const extension =
        match[2]

    let parsedUrl:
        | URL
        | undefined

    try {
        parsedUrl =
            new URL(url)
    } catch {}

    const EmojiStore =
        getEmojiStore()

    let emoji: any

    try {
        emoji =
            EmojiStore
                ?.getCustomEmojiById
                ?.(id)
    } catch {}

    const name =
        emoji?.name ??
        parsedUrl
            ?.searchParams
            .get("name") ??
        "<realmoji>"

    const animated =
        extension === "gif" ||
        parsedUrl
            ?.searchParams
            .get("animated") ===
            "true" ||
        emoji?.animated === true

    const coreUrl =
        `https://cdn.discordapp.com/emojis/${id}.` +
        (
            animated
                ? "gif"
                : "webp"
        )

    const src =
        `${coreUrl}?size=128`

    return {
        id,
        name,
        src,
        frozenSrc:
            src.replace(
                ".gif",
                ".webp",
            ),
    }
}

function createCustomEmoji(
    url: string,
    jumbo: boolean,
) {
    const info =
        getEmojiInfo(url)

    if (!info) {
        return
    }

    return {
        id: info.id,
        alt: info.name,
        src: info.src,
        frozenSrc:
            info.frozenSrc,
        type: "customEmoji",
        jumboable:
            jumbo
                ? true
                : undefined,
    }
}

function isWhitespaceText(
    item: any,
) {
    return (
        item?.type ===
            "text" &&
        typeof item?.content ===
            "string" &&
        item.content.trim() === ""
    )
}

function trimOuterWhitespace(
    content: any[],
) {
    while (
        content.length &&
        isWhitespaceText(
            content[0],
        )
    ) {
        content.shift()
    }

    while (
        content.length &&
        isWhitespaceText(
            content[
                content.length - 1
            ],
        )
    ) {
        content.pop()
    }

    if (
        content[0]?.type ===
            "text" &&
        typeof content[0]
            ?.content ===
            "string"
    ) {
        content[0].content =
            content[0]
                .content
                .trimStart()
    }

    const last =
        content[
            content.length - 1
        ]

    if (
        last?.type ===
            "text" &&
        typeof last?.content ===
            "string"
    ) {
        last.content =
            last.content
                .trimEnd()
    }
}

function convertLinks(
    content: any[],
) {
    if (
        !Array.isArray(content)
    ) {
        return false
    }

    const meaningful =
        content.filter(
            (item: any) =>
                !isWhitespaceText(
                    item,
                ),
        )

    const jumbo =
        meaningful.length > 0 &&
        meaningful.every(
            (item: any) =>
                item?.type ===
                    "link" &&
                typeof item?.target ===
                    "string" &&
                emojiRegex.test(
                    item.target,
                ),
        )

    let converted =
        false

    for (
        let i = 0;
        i < content.length;
        i++
    ) {
        const item =
            content[i]

        if (
            item?.type !==
                "link" ||
            typeof item?.target !==
                "string"
        ) {
            continue
        }

        if (
            !emojiRegex.test(
                item.target,
            )
        ) {
            continue
        }

        const emoji =
            createCustomEmoji(
                item.target,
                jumbo,
            )

        if (!emoji) {
            continue
        }

        content[i] =
            emoji

        converted =
            true
    }

    if (converted) {
        trimOuterWhitespace(
            content,
        )
    }

    return converted
}

function removeEmojiEmbeds(
    message: any,
) {
    if (
        !Array.isArray(
            message?.embeds,
        )
    ) {
        return
    }

    message.embeds =
        message.embeds.filter(
            (embed: any) => {
                const url =
                    embed?.url ??
                    embed
                        ?.image
                        ?.url

                return !(
                    embed?.type ===
                        "image" &&
                    typeof url ===
                        "string" &&
                    emojiRegex.test(
                        url,
                    )
                )
            },
        )
}

function clearEmbedLayout(
    message: any,
) {
    message.useAttachmentGridLayout =
        false

    message.useAttachmentUploadPreview =
        false
}

function convertEmbedOnlyMessage(
    message: any,
) {

    if (
        !Array.isArray(
            message?.content,
        ) ||
        message.content.length !==
            0 ||
        !Array.isArray(
            message?.embeds,
        )
    ) {
        return false
    }

    const urls:
        string[] = []

    for (
        const embed of
            message.embeds
    ) {
        const url =
            embed?.url ??
            embed
                ?.image
                ?.url

        if (
            embed?.type ===
                "image" &&
            typeof url ===
                "string" &&
            emojiRegex.test(
                url,
            )
        ) {
            urls.push(url)
        }
    }

    if (!urls.length) {
        return false
    }

    const newContent:
        any[] = []

    for (
        let i = 0;
        i < urls.length;
        i++
    ) {
        const emoji =
            createCustomEmoji(
                urls[i],
                true,
            )

        if (!emoji) {
            continue
        }

        if (
            newContent.length
        ) {
            newContent.push({
                content: " ",
                type: "text",
                jumboable: true,
            })
        }

        newContent.push(
            emoji,
        )
    }

    if (
        !newContent.length
    ) {
        return false
    }

    message.content =
        newContent

    removeEmojiEmbeds(
        message,
    )

    clearEmbedLayout(
        message,
    )

    return true
}

function processNativeRow(
    row: any,
) {
    if (
        row?.type !== 1 ||
        !row?.message
    ) {
        return
    }

    const message =
        row.message

    if (
        convertEmbedOnlyMessage(
            message,
        )
    ) {
        return
    }

    if (
        convertLinks(
            message.content,
        )
    ) {
        removeEmojiEmbeds(
            message,
        )

        clearEmbedLayout(
            message,
        )
    }
}

function processRows(
    rows: any[],
) {
    if (
        !Array.isArray(rows)
    ) {
        return
    }

    for (
        const row of rows
    ) {
        try {
            processNativeRow(
                row,
            )
        } catch (
            error
        ) {
            console.error(
                "[RealMoji] Failed to process row",
                error,
            )
        }
    }
}

export default plugin({
    start() {
        if (
            !NativeChatModule
                ?.updateRows
        ) {
            throw new Error(
                "NativeChatModule.updateRows not found",
            )
        }

        unpatch =
            before(
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
                            JSON.parse(
                                args[1],
                            )

                        processRows(
                            rows,
                        )

                        args[1] =
                            JSON.stringify(
                                rows,
                            )
                    } catch (
                        error
                    ) {
                        console.error(
                            "[RealMoji] updateRows error",
                            error,
                        )
                    }

                    return args
                },
            )
    },

    stop() {
        try {
            unpatch?.()
        } catch {}

        unpatch =
            undefined

        cachedEmojiStore =
            undefined
    },
})