// The below copyright notice and the license permission notice
// shall be included in all copies or substantial portions.
// Copyright (C) 2019-2021 Yury Chetyrko <ychetyrko@gmail.com>
// MIT License: https://raw.githubusercontent.com/nezaboodka/reactronic-front/master/LICENSE
// By contributing, you agree that your contributions will be
// automatically licensed under the license referred above.

import { reaction, nonreactive, Transaction, Rx, options, Reentrance } from 'reactronic'
import { Render, SuperRender, RxNodeType, AbstractRxNodeImpl, RxNode } from './RxDom.Types'

const EMPTY: Array<RxNode<any, any>> = Object.freeze([]) as any
const NOP = (): void => { /* nop */ }
const SYS: RxNodeType<any, any> = { name: 'RxDom.Node', sequential: false }

// RxNodeImpl

export class RxNodeImpl<E = unknown, O = void> implements AbstractRxNodeImpl<E, O> {
  private static gUuid: number = 0
  readonly uuid: number
  readonly level: number
  revision: number = 0
  native?: E = undefined
  model?: unknown = undefined
  children: ReadonlyArray<RxNode<any, any>> = EMPTY
  buffer: Array<RxNode<any, any>> | undefined = undefined
  aliens: ReadonlyArray<RxNode<any, any>> = EMPTY
  resizing?: ResizeObserver = undefined

  constructor(level: number) {
    this.uuid = ++RxNodeImpl.gUuid
    this.level = level
  }

  @reaction @options({
    reentrance: Reentrance.CancelPrevious,
    sensitiveArgs: true,
    noSideEffects: true })
  render(node: RxNode<E, O>): void {
    RxDom.invokeRender(this, node)
    Rx.configureCurrentOperation({ order: this.level })
  }

  // get ['#this'](): string {
  //   return `${this.info.rtti.name}.${this.info.id}`
  // }
}

// RxDom

export class RxDom {
  static readonly ROOT = RxDom.createRootNode<unknown>('ROOT', false, 'ROOT')
  static gTrace: string | undefined = undefined
  static gTraceMask: string = 'r'

  static Root<T>(render: () => T): T {
    const self = RxDom.ROOT.instance!
    if (self.buffer)
      throw new Error('rendering re-entrance is not supported yet')
    self.buffer = []
    let result: any = render()
    if (result instanceof Promise)
      result = result.then( // causes wrapping of then/catch to execute within current owner and host
        value => { Transaction.run(RxDom.renderChildrenThenDo, NOP); return value }, // ignored if rendered already
        error => { console.log(error); Transaction.run(RxDom.renderChildrenThenDo, NOP) }) // try to render children regardless the owner
    else
      Transaction.run(RxDom.renderChildrenThenDo, NOP) // ignored if rendered already
    return result
  }

  static Node<E = unknown, O = void>(id: string, args: any,
    render: Render<E, O>, superRender?: SuperRender<O, E>,
    priority?: number, type?: RxNodeType<E, O>, inline?: boolean,
    owner?: RxNode, host?: RxNode): RxNode<E, O> {
    const o = owner ?? gContext
    const h = host ?? gHost
    const self = o.instance
    if (!self)
      throw new Error('element must be initialized before children')
    const node = new RxNode<E, O>(id, args, render, superRender, priority ?? 0, type ?? SYS, inline ?? false, o, h)
    if (self.buffer === undefined)
      throw new Error('children are rendered already') // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const rev = h?.instance?.revision ?? -1
    if (rev >= 0) // emit only if host is alive
      self.buffer.push(node)
    return node
  }

  static render(node: RxNode<any, any>): void {
    const self = node.instance
    if (!self)
      throw new Error('element must be initialized before rendering')
    if (self.buffer)
      throw new Error('rendering re-entrance is not supported yet')
    const outerOwner = gContext
    const outerHost = gHost
    try {
      gContext = node
      gHost = self.native ? node : node.host
      self.buffer = []
      if (RxDom.gTrace && RxDom.gTraceMask.indexOf('r') >= 0 && new RegExp(RxDom.gTrace, 'gi').test(getTraceHint(node)))
        console.log(`t${Transaction.current.id}v${Transaction.current.timestamp}${'  '.repeat(Math.abs(node.instance!.level))}${getTraceHint(node)}.render/${node.instance?.revision}${!node.inline ? `  <<  ${Rx.why(true)}` : ''}`)
      let result: any
      if (node.superRender)
        result = node.superRender(options => {
          const res = node.render(self.native, options)
          if (res instanceof Promise)
            return res.then() // causes wrapping of then/catch to execute within current owner and host
          else
            return options
        }, self.native)
      else
        result = node.render(self.native, undefined)
      if (result instanceof Promise)
        result = result.then( // causes wrapping of then/catch to execute within current owner and host
          value => { RxDom.renderChildrenThenDo(NOP); return value }, // ignored if rendered already
          error => { console.log(error); RxDom.renderChildrenThenDo(NOP) }) // do not render children in case of owner error
      else
        RxDom.renderChildrenThenDo(NOP) // ignored if rendered already
    }
    finally {
      gHost = outerHost
      gContext = outerOwner
    }
  }

  static renderChildrenThenDo(action: () => void): void {
    const node = gContext
    if (node.type.sequential)
      RxDom.mergeAndRenderSequentialChildren(node, action)
    else
      RxDom.mergeAndRenderChildren(node, action)
  }

  static initialize(node: RxNode): void {
    RxDom.doInitialize(node)
  }

  static finalize(node: RxNode<any, any>, cause: RxNode): void {
    const self = node.instance
    if (self && self.revision >= 0) {
      self.revision = -self.revision
      self.native = undefined
      for (const x of self.children)
        RxDom.doFinalize(x, cause)
      for (const x of self.aliens)
        RxDom.doFinalize(x, cause)
    }
  }

  static usingAnotherHost<E>(host: RxNode<E>, run: (e: E) => void): void {
    const native = host.instance?.native
    if (native !== undefined) {
      const outer = gHost
      try {
        gHost = host
        run(native)
      }
      finally {
        gHost = outer
      }
    }
  }

  static createRootNode<E>(id: string, sequential: boolean, native: E): RxNode<E> {
    const self = new RxNodeImpl<E>(0)
    const node = new RxNode<E>(
      id,                       // id
      null,                     // args
      () => { /* nop */ },      // render
      undefined,                // superRender
      0,                        // priority
      { name: id, sequential }, // type
      false,                    // inline
      {} as RxNode,             // owner (lifecycle manager)
      {} as RxNode,             // host (rendering parent)
      self)                     // instance
    // Initialize
    const a: any = node
    a['owner'] = node
    a['host'] = node
    self.native = native
    return node
  }

  // currentNodeInstance, currentNodeRevision, trace, forAll

  static currentNodeInstance<T>(): { model?: T } {
    const self = gContext.instance
    if (!self)
      throw new Error('currentNodeInstance function can be called only inside rendering function')
    return self as { model?: T }
  }

  static currentNodeInstanceInternal<E>(): RxNodeImpl<E> {
    const self = gContext.instance
    if (!self)
      throw new Error('currentNodeInstanceInternal function can be called only inside rendering function')
    return self
  }

  static currentNodeRevision(): number {
    return gContext.instance?.revision ?? 0
  }

  static setTraceMode(enabled: boolean, mask: string, regexp: string): void {
    RxDom.gTrace = enabled ? regexp : undefined
    RxDom.gTraceMask = mask
  }

  static forAll<E>(action: (e: E) => void): void {
    RxDom.forEachChildRecursively(RxDom.ROOT, action)
  }

  static invokeRender<E, O>(instance: RxNodeImpl<E, O>, node: RxNode<E, O>): void {
    instance.revision++
    if (node.type.render)
      node.type.render(node)
    else
      RxDom.render(node)
  }

  // Internal

  private static doRender(node: RxNode): void {
    const self = node.instance!
    if (node.inline) // inline elements are always rendered
      RxDom.invokeRender(self, node)
    else // rendering of reactive elements is cached to avoid redundant calls
      nonreactive(self.render, node)
  }

  private static doInitialize(node: RxNode): RxNodeImpl {
    // TODO: Make the code below exception-safe
    const rtti = node.type
    const self = node.instance = new RxNodeImpl(node.owner.instance!.level + 1)
    rtti.initialize?.(node)
    rtti.mount?.(node)
    if (!node.inline)
      Rx.setTraceHint(self, Rx.isTraceEnabled ? getTraceHint(node) : node.id)
    if (RxDom.gTrace && RxDom.gTraceMask.indexOf('m') >= 0 && new RegExp(RxDom.gTrace, 'gi').test(getTraceHint(node)))
      console.log(`t${Transaction.current.id}v${Transaction.current.timestamp}${'  '.repeat(Math.abs(node.instance!.level))}${getTraceHint(node)}.initialized`)
    return self
  }

  private static doFinalize(node: RxNode, cause: RxNode): void {
    if (RxDom.gTrace && RxDom.gTraceMask.indexOf('u') >= 0 && new RegExp(RxDom.gTrace, 'gi').test(getTraceHint(node)))
      console.log(`t${Transaction.current.id}v${Transaction.current.timestamp}${'  '.repeat(Math.abs(node.instance!.level))}${getTraceHint(node)}.finalizing`)
    if (!node.inline && node.instance) // TODO: Consider creating one transaction for all finalizations at once
      Transaction.runAs({ standalone: true }, () => Rx.dispose(node.instance))
    const rtti = node.type
    if (rtti.finalize)
      rtti.finalize(node, cause)
    else
      RxDom.finalize(node, cause) // default finalize
  }

  private static mergeAndRenderSequentialChildren(node: RxNode, finish: () => void): void {
    const self = node.instance
    if (self !== undefined && self.buffer !== undefined) {
      let promised: Promise<void> | undefined = undefined
      try {
        const existing = self.children
        const sequenced = self.buffer
        const sorted = sequenced.slice().sort(compareNodes)
        self.buffer = undefined
        // Merge loop (always synchronous) - link to existing or finalize
        let host = self
        let aliens: Array<RxNode<any, any>> = EMPTY
        let sibling: RxNode | undefined = undefined
        let i = 0, j = 0
        while (i < existing.length) {
          const old = existing[i]
          const x = sorted[j]
          const diff = x !== undefined ? compareNodes(x, old) : 1
          if (diff <= 0) {
            const h = x.host.instance
            if (h !== self) {
              if (h !== host) {
                RxDom.mergeAliens(host, self, aliens)
                aliens = []
                host = h!
              }
              aliens.push(x)
            }
            if (sibling !== undefined && x.id === sibling.id)
              throw new Error(`duplicate id '${sibling.id}' inside '${node.id}'`)
            if (diff === 0) {
              x.instance = old.instance
              x.old = old
              i++, j++ // re-rendering is called below
            }
            else // diff < 0
              j++ // initial rendering is called below
            sibling = x
          }
          else { // diff > 0
            if (!Transaction.isCanceled)
              RxDom.doFinalize(old, old)
            i++
          }
        }
        if (host !== self)
          RxDom.mergeAliens(host, self, aliens)
        // Merge loop - initialize, render, re-render
        sibling = undefined
        i = 0, j = -1
        while (i < sequenced.length && !Transaction.isCanceled) {
          const x = sequenced[i]
          const old = x.old
          x.old = undefined // unlink to make it available for garbage collection
          x.sibling = sibling // link with sibling
          const instance = x.instance
          if (old && instance) {
            if (sibling?.instance !== old.sibling?.instance) // if sequence is changed
              x.type.mount?.(x)
            if (x.inline || !argsAreEqual(x.args, old.args))
              RxDom.doRender(x) // re-rendering
          }
          else {
            RxDom.doInitialize(x)
            RxDom.doRender(x) // initial rendering
          }
          if (x.native)
            sibling = x
          if (x.priority > 0 && j < 0)
            j = i
          i++
        }
        if (!Transaction.isCanceled) {
          self.children = sorted // switch to the new list
          if (j >= 0) // Incremental rendering (if any)
            promised = RxDom.renderIncrementally(node, sequenced, j).then(finish, finish)
        }
      }
      finally {
        if (promised)
          finish()
      }
    }
  }


  private static mergeAndRenderChildren(node: RxNode, finish: () => void): void {
    const self = node.instance
    if (self !== undefined && self.buffer !== undefined) {
      let promised: Promise<void> | undefined = undefined
      try {
        const existing = self.children
        const buffer = self.buffer.sort(compareNodes)
        const postponed = new Array<RxNode<any, any>>()
        self.buffer = undefined
        // Merge loop (always synchronous): link, render/initialize (priority 0), finalize
        let host = self
        let aliens: Array<RxNode<any, any>> = EMPTY
        let sibling: RxNode | undefined = undefined
        let i = 0, j = 0
        while (i < existing.length || j < buffer.length) {
          const old = existing[i]
          const x = buffer[j]
          const diff = compareNullable(x, old, compareNodes)
          if (diff <= 0) {
            const h = x.host.instance
            if (h !== self) {
              if (h !== host) {
                RxDom.mergeAliens(host, self, aliens)
                aliens = []
                host = h!
              }
              aliens.push(x)
            }
            if (sibling !== undefined && x.id === sibling.id)
              throw new Error(`duplicate id '${sibling.id}' inside '${node.id}'`)
            if (diff === 0) {
              if (old.instance) {
                x.instance = old.instance // link to the existing instance
                if (x.inline || !argsAreEqual(x.args, old.args)) {
                  if (!Transaction.isCanceled) {
                    if (x.priority === 0)
                      RxDom.doRender(x) // re-rendering
                    else
                      postponed.push(x)
                  }
                }
              }
              else {
                if (!Transaction.isCanceled) {
                  if (x.priority === 0) {
                    RxDom.doInitialize(x)
                    RxDom.doRender(x) // initial rendering
                  }
                  else
                    postponed.push(x)
                }
              }
              i++, j++
            }
            else { // diff < 0
              if (!Transaction.isCanceled) {
                if (x.priority === 0) {
                  RxDom.doInitialize(x)
                  RxDom.doRender(x) // initial rendering
                }
                else
                  postponed.push(x)
              }
              j++
            }
            sibling = x
          }
          else { // diff > 0
            if (!Transaction.isCanceled)
              RxDom.doFinalize(old, old)
            i++
          }
        }
        if (host !== self)
          RxDom.mergeAliens(host, self, aliens)
        if (!Transaction.isCanceled) {
          self.children = buffer // switch to the new list
          if (postponed.length > 0) // Incremental rendering (if any)
            promised = RxDom.renderIncrementally(node, postponed,  0).then(finish, finish)
        }
      }
      finally {
        if (!promised)
          finish()
      }
    }
  }

  private static async renderIncrementally(parent: RxNode, children: Array<RxNode>, startIndex: number,
    checkEveryN: number = 30, timeLimit: number = 12): Promise<void> {
    if (Transaction.isFrameOver(checkEveryN, timeLimit))
      await Transaction.requestNextFrame()
    if (!Transaction.isCanceled) {
      children.sort(compareNodesByPriority)
      let i = startIndex
      while (i < children.length) {
        const x = children[i]
        if (!x.instance)
          RxDom.doInitialize(x)
        RxDom.doRender(x)
        if (Transaction.isCanceled)
          break
        if (Transaction.isFrameOver(checkEveryN, timeLimit))
          await Transaction.requestNextFrame()
        if (Transaction.isCanceled)
          break
        i++
      }
    }
  }

  private static mergeAliens(host: AbstractRxNodeImpl, owner: AbstractRxNodeImpl, aliens: Array<RxNode<any, any>>): void {
    if (host !== owner) {
      const existing = host.aliens
      const merged: Array<RxNode<any, any>> = []
      let i = 0, j = 0 // TODO: Consider using binary search to find initial index
      while (i < existing.length || j < aliens.length) {
        const old = existing[i]
        const x = aliens[j]
        const diff = compareNullable(x, old, compareNodes)
        if (diff <= 0) {
          merged.push(x)
          if (diff === 0)
            i++, j++
          else // diff < 0
            j++
        }
        else { // diff > 0
          if (old.owner.instance !== owner)
            merged.push(old) // leave children of other owners untouched
          i++
        }
      }
      host.aliens = merged
    }
  }

  private static forEachChildRecursively(node: RxNode, action: (e: any) => void): void {
    const self = node.instance
    if (self) {
      const native = self.native
      native && action(native)
      self.children.forEach(x => RxDom.forEachChildRecursively(x, action))
    }
  }
}

function wrap(func: (...args: any[]) => any): (...args: any[]) => any {
  const owner = gContext
  const host = gHost
  const wrappedRendering = (...args: any[]): any => {
    return runUnder(owner, host, func, ...args)
  }
  return wrappedRendering
}

function runUnder(owner: RxNode, host: RxNode, func: (...args: any[]) => any, ...args: any[]): any {
  const outerOwner = gContext
  const outerHost = gHost
  try {
    gContext = owner
    gHost = host
    return func(...args)
  }
  finally {
    gHost = outerHost
    gContext = outerOwner
  }
}

function compareNodes(node1: RxNode, node2: RxNode): number {
  let result: number = 0
  const hp1 = node1.host.instance
  const hp2 = node2.host.instance
  if (hp1 !== hp2) {
    result = hp1!.uuid - hp2!.uuid
    if (result === 0)
      result = node1.id.localeCompare(node2.id)
  }
  else
    result = node1.id.localeCompare(node2.id)
  return result
}

function compareNodesByPriority(node1: RxNode, node2: RxNode): number {
  return node1.priority - node2.priority
}

function compareNullable<T>(a: T | undefined, b: T | undefined, comparer: (a: T, b: T) => number): number {
  let diff: number
  if (b !== undefined)
    diff = a !== undefined ? comparer(a, b) : 1
  else
    diff = a !== undefined ? -1 : 0
  return diff
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

function getTraceHint(node: RxNode): string {
  return `${node.type.name}:${node.id}`
}

const ORIGINAL_PROMISE_THEN = Promise.prototype.then

function reactronicFrontHookedThen(this: any,
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

Promise.prototype.then = reactronicFrontHookedThen

// Globals

let gContext: RxNode<any, any> = RxDom.ROOT
let gHost: RxNode<any, any> = RxDom.ROOT
