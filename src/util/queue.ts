interface Waiter<T> {
  resolve (result: IteratorResult<T>): void
  reject (err: Error): void
}

// Push-based async iterable: producers push, one consumer iterates.
// Items pushed before the consumer starts are buffered.
export class EventQueue<T> implements AsyncIterable<T> {
  #items: T[] = []
  #waiters: Array<Waiter<T>> = []
  #done = false
  #error: Error | null = null

  push (value: T): void {
    if (this.#done) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.#items.push(value)
  }

  end (): void {
    if (this.#done) return
    this.#done = true
    for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined, done: true })
  }

  fail (err: Error): void {
    if (this.#done) return
    this.#error = err
    this.#done = true
    for (const w of this.#waiters.splice(0)) w.reject(err)
  }

  [Symbol.asyncIterator] (): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift() as T, done: false })
        if (this.#error) return Promise.reject(this.#error)
        if (this.#done) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) => { this.#waiters.push({ resolve, reject }) })
      },
      return: async () => {
        this.end()
        this.#items = []
        return { value: undefined, done: true }
      }
    }
  }
}
