import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
export class Notifications {
  constructor(redis, encryption, sender, {ttl = 86400} = {}) {
    this.redis = redis; this.encryption = encryption; this.sender = sender; this.ttl = ttl;
  }
  userKey(user) { return `roomcare:user:${digest(user)}`; }
  async register(user, token) {
    const key = `${this.userKey(user)}:tokens`;
    const hash = digest(token);
    if (!(await this.redis.hExists(key, hash)) && await this.redis.hLen(key) >= 10) {
      throw Object.assign(new Error('At most 10 push tokens per user'), {status: 409});
    }
    await this.redis.hSet(key, hash, this.encryption.encrypt(token));
  }
  async remove(user, token) { await this.redis.hDel(`${this.userKey(user)}:tokens`, digest(token)); }
  async list(user) {
    return (await this.redis.lRange(`${this.userKey(user)}:notifications`, 0, 99)).map(JSON.parse);
  }
  async send(event) {
    const key = `roomcare:event:${digest(event.userId + ':' + event.eventId)}`;
    const claim = randomUUID();
    if (!await this.redis.set(key, claim, {NX: true, EX: this.ttl})) {
      return {eventId: event.eventId, status: 'duplicate'};
    }
    try {
      const encrypted = await this.redis.hVals(`${this.userKey(event.userId)}:tokens`);
      const tokens = encrypted.map(value => this.encryption.decrypt(value));
      const result = await this.sender(tokens, event);
      for (const token of result.invalidTokens ?? []) await this.remove(event.userId, token);
      const record = {
        id: event.eventId, title: event.title, body: event.body, data: event.data ?? {},
        createdAt: new Date().toISOString(), status: result.status,
        targetCount: tokens.length, successCount: result.successCount ?? 0
      };
      const listKey = `${this.userKey(event.userId)}:notifications`;
      await this.redis.multi().lPush(listKey, JSON.stringify(record)).lTrim(listKey, 0, 99).exec();
      return {eventId: event.eventId, ...record};
    } catch (error) {
      await this.redis.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", {keys: [key], arguments: [claim]});
      throw error;
    }
  }
}
