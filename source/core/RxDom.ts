// The below copyright notice and the license permission notice
// shall be included in all copies or substantial portions.
// Copyright (C) 2019-2021 Yury Chetyrko <ychetyrko@gmail.com>
// MIT License: https://raw.githubusercontent.com/nezaboodka/reactronic-dom/master/LICENSE
// By contributing, you agree that your contributions will be
// automatically licensed under the license referred above.

import { reaction, Transaction, Rx, options, Reentrance, nonreactive } from 'reactronic'
import { RxNodeType, Render, RxNode, SuperRender, RxNodeChildren, RxPriority } from './RxDom.Types'

// BasicNodeType

export class BasicNodeType<E, O> implements RxNodeType<E, O> {
  constructor(
    readonly name: string,
    readonly sequential: boolean) {
  }

  initialize(node: RxNode<E, O>): void {
    if (!node.inline)
      Rx.setTraceHint(node, node.id)
  }

  render(node: RxNode<E, O>, args: unknown): void {
    let result: any
    const children = node.children as RxDomNodeChildren
    children.beginReconciliation(node.revision)
    if (node.superRender)
      result = node.superRender(options => {
        const res = node.render(node.native as E, options)
        if (res instanceof Promise)
          return res.then() // causes wrapping of then/catch to execute within current parent
        else
          return options
      }, node.native!)
    else
      result = node.render(node.native as E, args as O)
    if (result instanceof Promise)
      result = result.then( // causes wrapping of then/catch to execute within current parent
        value => { RxDom.renderChildrenThenDo(NOP); return value }, // ignored if rendered already
        error => { console.log(error); RxDom.renderChildrenThenDo(NOP) }) // do not render children in case of parent error
    else
      RxDom.renderChildrenThenDo(NOP) // ignored if rendered already
  }

  remove(node: RxNode<E, O>, initiator: RxNode): void {
    node.native = undefined
  }
}

// RxDomNode

class RxDomNode<E = any, O = any> implements RxNode<E, O> {
  // User-defined properties
  readonly id: string
  readonly type: RxNodeType<E, O>
  readonly inline: boolean
  args: unknown
  render: Render<E, O>
  superRender: SuperRender<O, E> | undefined
  priority: RxPriority
  childrenShuffling: boolean
  model?: unknown
  // System-managed properties
  readonly level: number
  readonly parent: RxDomNode
  revision: number
  reconciliationRevision: number
  prevMountSibling?: RxDomNode
  isMountRequired: boolean
  children: RxDomNodeChildren
  next?: RxDomNode
  prev?: RxDomNode
  native?: E
  resizeObserver?: ResizeObserver

  constructor(level: number, id: string, type: RxNodeType<E, O>, inline: boolean,
    args: unknown, render: Render<E, O>, superRender: SuperRender<O, E> | undefined,
    parent: RxDomNode) {
    // User-defined properties
    this.id = id
    this.type = type
    this.inline = inline
    this.args = args
    this.render = render
    this.superRender = superRender
    this.priority = RxPriority.SyncP0
    this.childrenShuffling = false
    this.model = undefined
    // System-managed properties
    this.level = level
    this.parent = parent
    this.revision = ~0
    this.reconciliationRevision = ~0
    this.prevMountSibling = this
    this.isMountRequired = true
    this.children = new RxDomNodeChildren()
    this.next = undefined
    this.prev = undefined
    this.native = undefined
    this.resizeObserver = undefined
  }

  @reaction
  @options({
    reentrance: Reentrance.CancelPrevious,
    sensitiveArgs: true,
    noSideEffects: true })
  rerender(args: unknown): void {
    if (this.revision === 0) // configure only once
      Rx.configureCurrentOperation({ order: this.level })
    invokeRenderIfNodeIsAlive(this, args)
  }
}

// RxDom

export class RxDom {
  public static readonly basic = new BasicNodeType<any, any>('basic', false)
  public static incrementalRenderingFrameDurationMs = 10

  static Root<T>(render: () => T): T {
    const root = gContext
    root.children.beginReconciliation(root.revision)
    let result: any = render()
    if (result instanceof Promise)
      result = result.then( // causes wrapping of then/catch to execute within current parent
        value => { Transaction.run(null, RxDom.renderChildrenThenDo, NOP); return value }, // ignored if rendered already
        error => { console.log(error); Transaction.run(null, RxDom.renderChildrenThenDo, NOP) }) // try to render children regardless the parent
    else
      Transaction.run(null, RxDom.renderChildrenThenDo, NOP) // ignored if rendered already
    return result
  }

  static Node<E = unknown, O = void>(id: string, args: any,
    render: Render<E, O>, superRender?: SuperRender<O, E>,
    type?: RxNodeType<E, O>, inline?: boolean): RxNode<E, O> {
    const parent = gContext
    const children = parent.children
    let result = children.tryToRetainExisting(id)
    if (result) {
      if (!argsAreEqual(result.args, args))
        result.args = args
      result.render = render
      result.superRender = superRender
    }
    else {
      result = new RxDomNode<E, O>(parent.level + 1, id,
        type ?? RxDom.basic, inline ?? false, args,
        render, superRender, parent)
      children.retainNewlyCreated(result)
    }
    return result
  }

  static renderChildrenThenDo(action: () => void): void {
    const parent = gContext
    let promised: Promise<void> | undefined = undefined
    try {
      const children = parent.children
      if (children.isReconciling) {
        // Remove missing children
        let x = children.endReconciliation()
        while (x !== undefined) {
          tryToRemove(x, x)
          x = x.next
        }
        // Render retained children
        const sequential = parent.type.sequential
        let p1: Array<RxDomNode> | undefined = undefined
        let p2: Array<RxDomNode> | undefined = undefined
        let mountSibling: RxDomNode | undefined = undefined
        x = children.first
        while (x !== undefined && !Transaction.isCanceled) {
          if (sequential && x.prevMountSibling !== mountSibling) {
            x.prevMountSibling = mountSibling
            x.isMountRequired = true
          }
          if (x.priority === RxPriority.SyncP0)
            tryToRender(x)
          else if (x.priority === RxPriority.AsyncP1)
            p1 = push(p1, x)
          else
            p2 = push(p2, x)
          if (x.native)
            mountSibling = x
          x = x.next
        }
        // Render incremental children (if any)
        if (!Transaction.isCanceled && p1 !== undefined || p2 !== undefined)
          promised = RxDom.renderIncrementally(parent, p1, p2).then(action, action)
      }
    }
    finally {
      if (!promised)
        action()
    }
  }

  static createRootNode<E = any, O = any>(id: string, sequential: boolean, native: E): RxNode<E, O> {
    const node = new RxDomNode<E, O>(
      0,                        // level
      id,                       // id
      { name: id, sequential }, // type
      false,                    // inline
      null,                     // args
      () => { /* nop */ },      // render
      undefined,                // superRender
      {} as RxDomNode)         // fake parent (overwritten below)
    // Initialize
    const a: any = node
    a['parent'] = node
    node.native = native
    node.revision = 0 // initialized
    return node
  }

  static get currentNode(): RxNode {
    return gContext
  }

  static currentNodeModel<M>(): { model?: M } {
    return gContext as { model?: M }
  }

  static forAll<E>(action: (e: E) => void): void {
    RxDom.forEachChildRecursively(SYSTEM, action)
  }

  // Internal

  private static async renderIncrementally(node: RxDomNode,
    p1children: Array<RxDomNode> | undefined,
    p2children: Array<RxDomNode> | undefined): Promise<void> {
    const checkEveryN = 30
    if (Transaction.isFrameOver(checkEveryN, RxDom.incrementalRenderingFrameDurationMs))
      await Transaction.requestNextFrame()
    if (!Transaction.isCanceled && p1children !== undefined) {
      if (node.childrenShuffling)
        shuffle(p1children)
      for (const x of p1children) {
        tryToRender(x)
        if (Transaction.isCanceled)
          break
        if (Transaction.isFrameOver(checkEveryN, RxDom.incrementalRenderingFrameDurationMs))
          await Transaction.requestNextFrame()
        if (Transaction.isCanceled)
          break
      }
    }
    if (!Transaction.isCanceled && p2children !== undefined) {
      if (node.childrenShuffling)
        shuffle(p2children)
      for (const x of p2children) {
        tryToRender(x)
        if (Transaction.isCanceled)
          break
        if (Transaction.isFrameOver(checkEveryN, RxDom.incrementalRenderingFrameDurationMs))
          await Transaction.requestNextFrame()
        if (Transaction.isCanceled)
          break
      }
    }
  }

  private static forEachChildRecursively(node: RxDomNode, action: (e: any) => void): void {
    const native = node.native
    native && action(native)
    let x = node.children.first
    while (x !== undefined) {
      RxDom.forEachChildRecursively(x, action)
      x = x.next
    }
  }
}

// Internal

function tryToRender(node: RxDomNode): void {
  const type = node.type
  if (node.revision === ~0) {
    node.revision = 0
    type.initialize?.(node)
  }
  if (node.isMountRequired) {
    node.isMountRequired = false
    type.mount?.(node)
  }
  if (node.inline)
    invokeRenderIfNodeIsAlive(node, node.args)
  else
    nonreactive(node.rerender, node.args) // reactive auto-rendering
}

function tryToRemove(node: RxDomNode, initiator: RxDomNode): void {
  if (node.revision >= ~0) {
    node.revision = ~node.revision
    // Remove node itself
    const type = node.type
    if (type.remove)
      type.remove(node, initiator)
    else
      RxDom.basic.remove(node, initiator) // default remove
    // Enqueue node for Rx.dispose if needed
    if (!node.inline) {
      gDisposalQueue.push(node)
      if (gDisposalQueue.length === 1) {
        Transaction.run({ standalone: 'disposal', hint: `runDisposalLoop(initiator=${node.id})` }, () => {
          void runDisposalLoop().then(NOP, error => console.log(error))
        })
      }
    }
    // Remove/enqueue children if any
    let x = node.children.first
    while (x !== undefined) {
      tryToRemove(x, initiator)
      x = x.next
    }
  }
}

function invokeRenderIfNodeIsAlive(node: RxDomNode, args: unknown): void {
  if (node.revision >= ~0) { // needed for deferred Rx.dispose
    runUnder(node, () => {
      node.revision++
      const type = node.type
      if (type.render)
        type.render(node, args) // type-defined rendering
      else
        RxDom.basic.render(node, args) // default rendering
    })
  }
}

async function runDisposalLoop(): Promise<void> {
  await Transaction.requestNextFrame()
  const queue = gDisposalQueue
  let i = 0
  while (i < queue.length) {
    if (Transaction.isFrameOver(500, 5))
      await Transaction.requestNextFrame()
    Rx.dispose(queue[i])
    i++
  }
  gDisposalQueue = [] // reset loop
}

function wrap<T>(func: (...args: any[]) => T): (...args: any[]) => T {
  const parent = gContext
  const wrappedRunUnder = (...args: any[]): T => {
    return runUnder(parent, func, ...args)
  }
  return wrappedRunUnder
}

function runUnder<T>(node: RxDomNode, func: (...args: any[]) => T, ...args: any[]): T {
  const outer = gContext
  try {
    gContext = node
    return func(...args)
  }
  finally {
    gContext = outer
  }
}

function argsAreEqual(a1: any, a2: any): boolean {
  let result = a1 === a2
  if (!result) {
    if (Array.isArray(a1)) {
      result = Array.isArray(a2) &&
        a1.length === a2.length &&
        a1.every((t, i) => t === a2[i])
    }
    else if (a1 === Object(a1) && a2 === Object(a2)) {
      for (const p in a1) {
        result = a1[p] === a2[p]
        if (!result)
          break
      }
    }
  }
  return result
}

function push<T>(array: Array<T> | undefined, item: T): Array<T> {
  if (array == undefined)
    array = new Array<T>()
  array.push(item)
  return array
}

function shuffle<T>(array: Array<T>): Array<T> {
  let i = array.length - 1
  while (i >= 0) {
    const j = Math.floor(Math.random() * i)
    const t = array[i]
    array[i] = array[j]
    array[j] = t
    i--
  }
  return array
}

// RxDomNodeChildren

export class RxDomNodeChildren implements RxNodeChildren {
  namespace: Map<string, RxDomNode> = new Map<string, RxDomNode>()
  first?: RxDomNode = undefined
  count: number = 0
  retainedFirst?: RxDomNode = undefined
  retainedLast?: RxDomNode = undefined
  retainedCount: number = 0
  likelyNextRetained?: RxDomNode = undefined
  revision: number = ~0

  get isReconciling(): boolean { return this.revision > ~0 }

  beginReconciliation(revision: number): void {
    if (this.isReconciling)
      throw new Error('reconciliation is not reentrant')
    this.revision = revision
  }

  endReconciliation(): RxDomNode | undefined {
    if (!this.isReconciling)
      throw new Error('reconciliation is ended already')
    this.revision = ~0
    const namespace = this.namespace
    const count = this.count
    const retained = this.retainedCount
    if (retained > 0) {
      if (retained > count) { // it should be faster to delete non-retained nodes from namespace
        let x = this.first
        while (x !== undefined)
          namespace.delete(x.id), x = x.next
      }
      else { // it should be faster to recreate namespace with retained nodes only
        const newNamespace = this.namespace = new Map<string, RxDomNode>()
        let x = this.retainedFirst
        while (x !== undefined)
          newNamespace.set(x.id, x), x = x.next
      }
    }
    else // just create new empty namespace
      this.namespace = new Map<string, RxDomNode>()
    const missingFirst = this.first
    this.first = this.retainedFirst
    this.count = retained
    this.retainedFirst = this.retainedLast = undefined
    this.retainedCount = 0
    this.likelyNextRetained = this.first
    return missingFirst
  }

  tryToRetainExisting(id: string): RxDomNode | undefined {
    let result = this.likelyNextRetained
    if (result?.id !== id)
      result = this.namespace.get(id)
    if (result && result.revision >= ~0) {
      if (result.reconciliationRevision === this.revision)
        throw new Error(`duplicate item id: ${id}`)
      result.reconciliationRevision = this.revision
      this.likelyNextRetained = result.next
      // Exclude from main sequence
      if (result.prev !== undefined)
        result.prev.next = result.next
      if (result.next !== undefined)
        result.next.prev = result.prev
      if (result === this.first)
        this.first = result.next
      this.count--
      // Include into retained sequence
      const last = this.retainedLast
      if (last) {
        result.prev = last
        result.next = undefined
        this.retainedLast = last.next = result
      }
      else {
        result.prev = result.next = undefined
        this.retainedFirst = this.retainedLast = result
      }
      this.retainedCount++
    }
    return result
  }

  retainNewlyCreated(node: RxDomNode): void {
    node.reconciliationRevision = this.revision
    this.namespace.set(node.id, node)
    const last = this.retainedLast
    if (last) {
      node.prev = last
      this.retainedLast = last.next = node
    }
    else
      this.retainedFirst = this.retainedLast = node
    this.retainedCount++
  }
}

// Support asynchronous programing automatically

const ORIGINAL_PROMISE_THEN = Promise.prototype.then

function reactronicDomHookedThen(this: any,
  resolve?: ((value: any) => any | PromiseLike<any>) | undefined | null,
  reject?: ((reason: any) => never | PromiseLike<never>) | undefined | null): Promise<any | never> {
  resolve = resolve ? wrap(resolve) : resolveReturn
  reject = reject ? wrap(reject) : rejectRethrow
  return ORIGINAL_PROMISE_THEN.call(this, resolve, reject)
}

/* istanbul ignore next */
export function resolveReturn(value: any): any {
  return value
}

/* istanbul ignore next */
export function rejectRethrow(error: any): never {
  throw error
}

Promise.prototype.then = reactronicDomHookedThen

// Globals

const NOP = (): void => { /* nop */ }
const SYSTEM = RxDom.createRootNode<any, any>('SYSTEM', false, 'SYSTEM') as RxDomNode
let gContext: RxDomNode = SYSTEM
let gDisposalQueue: Array<RxNode> = []
