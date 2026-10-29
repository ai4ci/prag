/**
 * An append-only ring buffer of recent events, used by beta's debug endpoint.
 */
export class EventRing<T> {
  private readonly slots: (T | undefined)[];
  private next = 0;
  private filled = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    this.slots = new Array<T | undefined>(capacity);
  }

  push(event: T): void {
    this.slots[this.next] = event;
    this.next = (this.next + 1) % this.slots.length;
    this.filled = Math.min(this.filled + 1, this.slots.length);
  }

  /** Events in insertion order, oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    const start = this.filled === this.slots.length ? this.next : 0;
    for (let i = 0; i < this.filled; i += 1) {
      out.push(this.slots[(start + i) % this.slots.length] as T);
    }
    return out;
  }
}
