/** The id of a chat's conversation entity: its record in the Library. Its own module so the sidebar's count can use it without loading the recorder. */
export const chatEntityId = (chatId: string) => `assistant-chat:${chatId}`
