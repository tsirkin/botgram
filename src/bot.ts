/**
 * Implements the main [[Bot]] class and its logic to process
 * incoming updates.
 */

import * as EventEmitter from 'events'
import { Client, ClientOptions, defaultOptions as clientOptions } from './client'
import { UpdateLoop, UpdateLoopOptions, defaultOptions as updateLoopOptions } from './update-loop'
import { integer, Update, Message, Chat } from './telegram'
import * as telegram from './telegram'
import { parseCommand, matchCommand, Command } from './util/text'
import * as webhook from './util/webhook'

/**
 * This is the main class, and probably the only one you need to
 * instantiate in most projects. It starts listening for incoming
 * updates, and allows you to define **handlers** to process them.
 *
 * To use this class, you must:
 *
 * 1. Create an instance, passing the authentication token.
 * 2. Register handlers by calling [[Bot.use]], [[Bot.onMessage]]
 *    and other methods.
 * 3. Call [[Bot.listen]] to start receiving messages.
 * 4. Throughout your code, use [[Bot.client]] to make requests
 *    to Telegram, or call methods in the received objects.
 * 
 * When an update arrives, it is placed in an [[IncomingUpdate]]
 * object (which also contains shortcuts for commonly accessed
 * properties) and calls the first matching handler, in order of
 * registration.
 *
 * Handlers may invoke the `next` argument to call the next matching
 * handler, in a similar way to Connect or Express.
 * 
 * By convention, handlers should return promises for their work, and
 * these will be returned by `next` and [[processUpdate]]. However
 * Botgram doesn't actually enforce this, `next` will return whatever
 * value was returned by the called handler.
 *
 * For more advanced use cases, you might want to directly
 * use the API client ([[Client]]) and/or the update-receiving
 * loop ([[UpdateLoop]]).
 */
export class Bot extends EventEmitter {

  /** The API client used by this bot */
  public client: Client
  /** Bot options */
  options: BotOptions

  /**
   * Construct a new [[Bot]] object
   * @param authToken The authentication token for the bot
   * @param options Bot & API client options
   */
  public constructor (authToken: string, options?: BotOptions) {
    super()
    this.options = { ...defaultOptions, ...options }
    this.client = new Client(authToken, this.options.clientOptions)
  }

  // Loop management

  private loop?: UpdateLoop

  /**
   * Start receiving updates from Telegram, via the long-polling method.
   * To stop receiving updates, use [[Bot.stop]].
   * 
   * **Important:** Make sure only one instance of your code is running
   * at the same time.
   * 
   * This is the easiest way to run a bot. However, if you want to use
   * a webhook (as with Serverless, for example) then don't call this
   * method. See the [[Webhook guide]].
   */
  public listen (): this {
    if (!this.loop) {
      this.loop = new UpdateLoop(this.client, this.options.updateLoopOptions)
      this.loop.on('sync', () => this.emit('sync'))
      this.loop.on('updates', (updates, queued) => this.handleBatch(updates, queued))
      this.loop.on('error', (error, retry) =>
        this.emit(retry ? 'updateError' : 'error', error))
    }
    return this
  }

  /**
   * Stop receiving updates. This allows the Node.JS process to finish
   * when everything is done. After calling this, [[listen]] may be
   * used to start reception again. Calling `stop` or `listen` many
   * times has no effect.
   */
  public stop (): this {
    if (this.loop) {
      this.loop.stop()
      this.loop = undefined
    }
    return this
  }

  private handleBatch (updates: Update[], queued: boolean): void {
    // FIXME: export queued
    updates.forEach(update => this._processUpdate(update, queued))
  }

  // Other methods for update reception

  /**
   * Parse a received update from Telegram (i.e. webhook body)
   * and call the first matching handler. The update may be supplied
   * as raw JSON (string / Buffer) or as a parsed object.
   * 
   * This method is useful if you want to use webhooks to get
   * updates from Telegram, and the existing integrations
   * aren't enough. Check out the [[Webhook guide]].
   * 
   * @param u Serialized update, as received from Telegram
   * @returns Whatever was returned by the handler (usually a Promise)
   */
  public processUpdate (u: Buffer | string | object): any {
    u = Buffer.isBuffer(u) ? u.toString('utf-8') : u
    u = (typeof u === 'string') ? JSON.parse(u) : u
    return this._processUpdate(new Update(u, this.client))
  }

  /**
   * See the `util/webhook` module.
   */
  public makeLambdaHandler () {
    return webhook.makeLambdaHandler(this)
  }

  /**
   * See the `util/webhook` module.
   */
  public makeMiddleware () {
    return webhook.makeMiddleware(this)
  }

  // Update processing

  protected parseUpdate (update: Update, queued?: boolean): IncomingUpdate | void {
    const base: IncomingUpdateBase = { id: update.update_id, update, queued }
    if (update.message) {
      let msg = update.message
      let chat = msg.chat
      return { ...base, type: 'message', msg, chat, edited: false }
    } else if (update.edited_message) {
      let msg = update.edited_message
      let chat = msg.chat
      return { ...base, type: 'edited_message', msg, chat, edited: true }
    } else if (update.channel_post) {
      let msg = update.channel_post
      let channel = msg.chat
      return { ...base, type: 'channel_post', msg, channel, edited: false }
    } else if (update.edited_channel_post) {
      let msg = update.edited_channel_post
      let channel = msg.chat
      return { ...base, type: 'edited_channel_post', msg, channel, edited: true }
    } else if (update.inline_query) {
      return { ...base, type: 'inline_query', query: update.inline_query }
    } else if (update.chosen_inline_result) {
      return { ...base, type: 'chosen_inline_result', result: update.chosen_inline_result }
    } else if (update.callback_query) {
      return { ...base, type: 'callback_query', query: update.callback_query }
    } else if (update.shipping_query) {
      return { ...base, type: 'shipping_query', query: update.shipping_query }
    } else if (update.pre_checkout_query) {
      return { ...base, type: 'pre_checkout_query', query: update.pre_checkout_query }
    } else if (update.poll) {
      return { ...base, type: 'poll', poll: update.poll }
    }
  }

  protected _processUpdate (update: Update, queued?: boolean): any {
    const info = this.parseUpdate(update, queued)
    if (typeof info !== 'undefined') {
      return this.callHandler(info)
    }
  }

  protected handlers: (Handler<this, IncomingUpdate>)[] = []

  protected callHandler (info: IncomingUpdate, idx: integer = 0): any {
    if (idx < this.handlers.length) {
      return this.handlers[idx].call(this, info, () => this.callHandler(info, idx + 1))
    }
  }

  public use (handler: Handler<this, IncomingUpdate>): this {
    this.handlers.push(handler)
    return this
  }

  // Generic handlers

  public onMessage (handler: Handler<this, IncomingMessage>): this {
    return this.use(filterHandler(info => info.type === 'message', handler))
  }

  public onEditedMessage (handler: Handler<this, IncomingEditedMessage>): this {
    return this.use(filterHandler(info => info.type === 'edited_message', handler))
  }

  public onChannelPost (handler: Handler<this, IncomingChannelPost>): this {
    return this.use(filterHandler(info => info.type === 'channel_post', handler))
  }

  public onEditedChannelPost (handler: Handler<this, IncomingEditedChannelPost>): this {
    return this.use(filterHandler(info => info.type === 'edited_channel_post', handler))
  }

  public onInlineQuery (handler: Handler<this, IncomingInlineQuery>): this {
    return this.use(filterHandler(info => info.type === 'inline_query', handler))
  }

  public onChosenInlineResult (handler: Handler<this, IncomingChosenInlineResult>): this {
    return this.use(filterHandler(info => info.type === 'chosen_inline_result', handler))
  }

  public onCallbackQuery (handler: Handler<this, IncomingCallbackQuery>): this {
    return this.use(filterHandler(info => info.type === 'callback_query', handler))
  }

  public onShippingQuery (handler: Handler<this, IncomingShippingQuery>): this {
    return this.use(filterHandler(info => info.type === 'shipping_query', handler))
  }

  public onPreCheckoutQuery (handler: Handler<this, IncomingPreCheckoutQuery>): this {
    return this.use(filterHandler(info => info.type === 'pre_checkout_query', handler))
  }

  public onPollUpdate (handler: Handler<this, IncomingPoll>): this {
    return this.use(filterHandler(info => info.type === 'poll', handler))
  }

  // Message handlers

  public onText (handler: Handler<this, IncomingTextMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.text !== undefined, handler))
  }

  public onAudio (handler: Handler<this, IncomingAudioMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.audio !== undefined, handler))
  }

  public onDocument (handler: Handler<this, IncomingDocumentMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.document !== undefined, handler))
  }

  public onAnimation (handler: Handler<this, IncomingAnimationMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.animation !== undefined, handler))
  }

  public onGame (handler: Handler<this, IncomingGameMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.game !== undefined, handler))
  }

  public onPhoto (handler: Handler<this, IncomingPhotoMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.photo !== undefined, handler))
  }

  public onSticker (handler: Handler<this, IncomingStickerMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.sticker !== undefined, handler))
  }

  public onVideo (handler: Handler<this, IncomingVideoMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.video !== undefined, handler))
  }

  public onVoice (handler: Handler<this, IncomingVoiceMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.voice !== undefined, handler))
  }

  public onVideoNote (handler: Handler<this, IncomingVideoNoteMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.video_note !== undefined, handler))
  }

  public onContact (handler: Handler<this, IncomingContactMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.contact !== undefined, handler))
  }

  public onLocation (handler: Handler<this, IncomingLocationMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.location !== undefined, handler))
  }

  public onVenue (handler: Handler<this, IncomingVenueMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.venue !== undefined, handler))
  }

  public onPoll (handler: Handler<this, IncomingPollMessage>): this {
    return this.onMessage(filterHandler(info => info.msg.poll !== undefined, handler))
  }

  // Command handler API

  public onCommand (handler: Handler<this, IncomingCommandMessage>): this
  public onCommand (name: (string | RegExp), handler: Handler<this, IncomingCommandMessage>): this
  public onCommand (name1: (string | RegExp), name2: (string | RegExp), handler: Handler<this, IncomingCommandMessage>): this
  public onCommand (name1: (string | RegExp), name2: (string | RegExp), name3: (string | RegExp), handler: Handler<this, IncomingCommandMessage>): this
  public onCommand (...namesOrHandler: (string | RegExp | Handler<this, IncomingCommandMessage>)[]): this

  public onCommand (...namesOrHandler: (string | RegExp | Handler<this, IncomingCommandMessage>)[]): this {
    const names = namesOrHandler.slice(0, namesOrHandler.length - 1) as (string | RegExp)[]
    const handler = namesOrHandler[namesOrHandler.length - 1]
    if (typeof handler !== 'function') {
      throw new Error('Invalid handler was passed')
    }
    return this.onMessage(filterHandler(info => {
      const command = (info as IncomingCommandMessage).command || parseCommand(info.msg)
      if (!command) {
        return false
      }
      if (names.length && !matchCommand(command.name, names)) {
        return false
      }
      (info as IncomingCommandMessage).command = command
      return true
    }, handler))
  }

}

export type Handler<T, I extends IncomingUpdate> =
  (this: T, info: I, next: () => any) => void

const filterHandler = <T, I1 extends IncomingUpdate, I2 extends I1>(
  filter: (info: I1) => boolean,
  handler: Handler<T, I2>): Handler<T, I1> =>
  function (info, next) { return filter(info) ? handler.call(this, info as I2, next) : next() }

/**
 * Default options for the bot object
 */
export const defaultOptions: BotOptions = {
  clientOptions,
  updateLoopOptions,
}

/**
 * Options for the bot object
 */
export interface BotOptions {
  clientOptions?: ClientOptions
  updateLoopOptions?: UpdateLoopOptions
}

export default Bot

// INFO TYPES

export interface IncomingUpdateBase {
  update: Update
  id: integer
  type?: telegram.UpdateKind
  queued?: boolean
}

export type IncomingUpdate =
  IncomingMessage |
  IncomingEditedMessage |
  IncomingChannelPost |
  IncomingEditedChannelPost |
  IncomingInlineQuery |
  IncomingChosenInlineResult |
  IncomingCallbackQuery |
  IncomingShippingQuery |
  IncomingPreCheckoutQuery |
  IncomingPoll

export interface IncomingMessage extends IncomingUpdateBase {
  type: 'message'
  msg: Message
  chat: Chat
  edited: false
}

export interface IncomingEditedMessage extends IncomingUpdateBase {
  type: 'edited_message'
  msg: Message
  chat: Chat
  edited: true
}

export interface IncomingChannelPost extends IncomingUpdateBase {
  type: 'channel_post'
  msg: Message
  channel: Chat
  edited: false
}

export interface IncomingEditedChannelPost extends IncomingUpdateBase {
  type: 'edited_channel_post'
  msg: Message
  channel: Chat
  edited: true
}

export interface IncomingInlineQuery extends IncomingUpdateBase {
  type: 'inline_query'
  query: telegram.InlineQuery
}

export interface IncomingChosenInlineResult extends IncomingUpdateBase {
  type: 'chosen_inline_result'
  result: telegram.ChosenInlineResult
}

export interface IncomingCallbackQuery extends IncomingUpdateBase {
  type: 'callback_query'
  query: telegram.CallbackQuery
}

export interface IncomingShippingQuery extends IncomingUpdateBase {
  type: 'shipping_query'
  query: telegram.ShippingQuery
}

export interface IncomingPreCheckoutQuery extends IncomingUpdateBase {
  type: 'pre_checkout_query'
  query: telegram.PreCheckoutQuery
}

export interface IncomingPoll extends IncomingUpdateBase {
  type: 'poll'
  poll: telegram.IPoll
}

export interface IncomingTextMessage extends IncomingMessage {
  msg: Message & { text: string }
}

export interface IncomingAudioMessage extends IncomingMessage {
  msg: Message & { audio: telegram.Audio }
}

export interface IncomingDocumentMessage extends IncomingMessage {
  msg: Message & { document: telegram.Document }
}

export interface IncomingAnimationMessage extends IncomingMessage {
  msg: Message & { animation: telegram.Animation }
}

export interface IncomingGameMessage extends IncomingMessage {
  msg: Message & { game: telegram.Game }
}

export interface IncomingPhotoMessage extends IncomingMessage {
  msg: Message & { photo: telegram.PhotoSize[] }
}

export interface IncomingStickerMessage extends IncomingMessage {
  msg: Message & { sticker: telegram.Sticker }
}

export interface IncomingVideoMessage extends IncomingMessage {
  msg: Message & { video: telegram.Video }
}

export interface IncomingVoiceMessage extends IncomingMessage {
  msg: Message & { voice: telegram.Voice }
}

export interface IncomingVideoNoteMessage extends IncomingMessage {
  msg: Message & { video_note: telegram.VideoNote }
}

export interface IncomingContactMessage extends IncomingMessage {
  msg: Message & { contact: telegram.IContact }
}

export interface IncomingLocationMessage extends IncomingMessage {
  msg: Message & { location: telegram.ILocation }
}

export interface IncomingVenueMessage extends IncomingMessage {
  msg: Message & { venue: telegram.IVenue }
}

export interface IncomingPollMessage extends IncomingMessage {
  msg: Message & { poll: telegram.IPoll }
}

export interface IncomingCommandMessage extends IncomingTextMessage {
  msg: Message & { text: string, entities: telegram.MessageEntity[] }
  command: Command
}