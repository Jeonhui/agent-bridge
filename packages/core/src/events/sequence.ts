/** Per-session event sequence generator. Continues across resume (spec 15.3). */
export class SequenceCounter {
  #last: number;

  constructor(resumingFrom = 0) {
    this.#last = resumingFrom;
  }

  next(): number {
    return ++this.#last;
  }

  get last(): number {
    return this.#last;
  }
}
