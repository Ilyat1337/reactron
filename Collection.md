﻿
# **Collection**

Collection provides fast merge of lists and detection of
differences/changes after the merge: which items are
added, moved, and removed.

``` typescript
const list = new Collection<string>(true, s => s)

const example1 = ['Hello', 'Welcome', 'Bye', 'End']
for (const x of example1)
  list.add(x)

// list.items: Hello, Welcome, Bye, End

const example2 = ['Added1', 'Bye', 'End', 'Added2', 'Hello', 'Added3']
list.beginMerge()
for (const x of example2)
  if (!list.claim(x)) // try to link with an existing item
    list.add(x, true) // otherwise add item as a new one
list.endMerge(true)

// list.items: Added1, Bye, End, Added2, Hello, Added3
// list.addedItems: Added1, Added2, Added3
// list.removedItems: Welcome
// list.isAdded: Added1, Added2, Added3
// list.isMoved: Bye, Hello
// list.isRemoved: Welcome
```

Collection API:

``` typescript
interface Item<T> {
  readonly self: T
}

class Collection<T> {
  readonly getKey: GetKey<T>
  readonly strict: boolean
  readonly count: number
  readonly addedCount: number
  readonly removedCount: number
  readonly isMergeInProgress: boolean

  lookup(key: string): Item<T> | undefined
  claim(key: string): Item<T> | undefined
  add(self: T, keepInAddedItems?: boolean): Item<T>
  remove(item: Item<T>, keepInRemovedItems?: boolean): void
  move(item: Item<T>, after: Item<T>): void
  beginMerge(): void
  endMerge(clearAddedAndRemovedItems: boolean): void

  items(): Generator<Item<T>>
  addedItems(keep?: boolean): Generator<Item<T>>
  removedItems(keep?: boolean): Generator<Item<T>>
  isAdded(item: Item<T>): boolean
  isMoved(item: Item<T>): boolean
  isRemoved(item: Item<T>): boolean
  isCurrent(item: Item<T>): boolean
}
```
