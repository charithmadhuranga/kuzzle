/*
 * Kuzzle, a backend software, self-hostable and ready to use
 * to power modern apps
 *
 * Copyright 2015-2020 Kuzzle
 * mailto: support AT kuzzle.io
 * website: http://kuzzle.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Bluebird = require('bluebird');
const debug = require('debug')('kuzzle:cluster');
const IORedis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const Node = require('./node');
const { Request } = require('kuzzle-common-objects');

IORedis.Promise = Bluebird;

class KuzzleCluster {
  constructor (kuzzle) {
    this.kuzzle = kuzzle;
    this.config = kuzzle.config;
    this.publisherUrl = this._resolveBinding(this.config.bindings.pub, 7511);
    this.routerUrl = this._resolveBinding(this.config.bindings.router, 7510);

    this._registerShutdownListeners();

    this.uuid = uuidv4();
    this.node = new Node(this);

    this.redis = Array.isArray(this.config.redis)
      ? new IORedis.Cluster(this.config.redis)
      : new IORedis(this.config.redis);

    this.redis.defineCommand('clusterCleanNode', {
      lua: fs.readFileSync(path.resolve(__dirname, 'redis/cleanNode.lua')),
      numberOfKeys: 1,
    });
    this.redis.defineCommand('clusterState', {
      lua: fs.readFileSync(path.resolve(__dirname, 'redis/getState.lua')),
      numberOfKeys: 1,
    });
    this.redis.defineCommand('clusterSubOn', {
      lua: fs.readFileSync(path.resolve(__dirname, 'redis/subon.lua')),
      numberOfKeys: 1,
    });
    this.redis.defineCommand('clusterSubOff', {
      lua: fs.readFileSync(path.resolve(__dirname, 'redis/suboff.lua')),
      numberOfKeys: 1,
    });


    this.hooks = {
      'admin:afterDump': 'dump',
      'admin:afterResetSecurity': 'resetSecurityCache',
      'admin:afterShutdown': 'shutdown',
      'collection:afterDeleteSpecifications': 'refreshSpecifications',
      'collection:afterUpdateSpecifications': 'refreshSpecifications',
      'core:indexCache:add': 'indexCacheAdded',
      'core:indexCache:remove': 'indexCacheRemoved',
      'core:kuzzleStart': 'kuzzleStarted',
      'core:notify:document': 'notifyDocument',
      'core:notify:user': 'notifyUser',
      'core:profileRepository:delete': 'profileUpdated',
      'core:profileRepository:save': 'profileUpdated',
      'core:roleRepository:delete': 'roleUpdated',
      'core:roleRepository:save': 'roleUpdated',
      'realtime:errorSubscribe': 'unlockCreateRoom',
      'realtime:errorUnsubscribe': 'unlockDeleteRoom',
      'room:new': 'roomCreated',
      'room:remove': 'roomDeleted',
    };

    this.pipes = {
      'core:auth:strategyAdded': 'strategyAdded',
      'core:auth:strategyRemoved': 'strategyRemoved',
      'core:hotelClerk:addSubscription': 'subscriptionAdded',
      'core:hotelClerk:join': 'subscriptionJoined',
      'core:hotelClerk:removeRoomForCustomer': 'subscriptionOff',
      'realtime:beforeJoin': 'beforeJoin'
    };

    this._isKuzzleStarted = false;

    this._rooms = {
      // Map.<room id, room>
      flat: new Map(),
      // Map.<index, Map.<collection, Set.<room id> > >
      tree: new Map()
    };

    this._shutdown = false;
  }

  get ready () {
    return this.node.ready;
  }

  get broadcast () {
    return this.node.broadcast;
  }



  // --------------------------------------------------------------------------
  // hooks
  // --------------------------------------------------------------------------

  /**
   * @param {Request} request
   * @param {function} cb callback
   * @param {integer} attempts
   */
  beforeJoin (request, cb, attempts = 0) {
    if (!request.input.body || !request.input.body.roomId) {
      return cb(null, request);
    }

    const roomId = request.input.body.roomId;

    if (this.kuzzle.hotelClerk.rooms.has(roomId)) {
      return cb(null, request);
    }

    const room = this._rooms.flat.get(roomId);

    if (room) {
      this.kuzzle.hotelClerk.rooms.set(roomId, {
        index: room.index,
        collection: room.collection,
        id: roomId,
        customers: new Set(),
        channels: {}
      });

      return cb(null, request);
    }

    // room not found. May be normal but can also be due to cluster state
    // propagation delay
    if (attempts > 0) {
      return cb(null, request);
    }

    setTimeout(
      () => this.beforeJoin(request, cb, attempts + 1),
      this.config.timers.joinAttemptInterval);
  }

  /**
   * Hook for core:indexCache:add
   *
   * @param {Object} payload - { index, collection, scope }
   */
  indexCacheAdded (payload) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "index cache added" action: node not connected to cluster', this.uuid);
      return;
    }

    this.node.broadcast('cluster:sync', {
      event: 'indexCache:add',
      ...payload
    });
  }

  /**
   * Hook for core:indexCache:remove
   *
   * @param {Object} payload - { index, collection, scope }
   */
  indexCacheRemoved (payload) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "index cache removed" action: node not connected to cluster', this.uuid);
      return;
    }

    this.node.broadcast('cluster:sync', {
      event: 'indexCache:remove',
      ...payload
    });
  }

  kuzzleStarted () {
    // kuzzle realtime overrides
    {
      const realtimeController = this.kuzzle.funnel.controllers.get('realtime');

      realtimeController.count = request => this._realtimeCountOverride(request);
      realtimeController.list = request => this._realtimeListOverride(request);
    }

    this.kuzzle.hotelClerk._removeRoomFromRealtimeEngine = id => {
      const room = this._rooms.flat.get(id);

      if (room && room.count > 1) {
        debug('[hotelClerk._removeRoomFromRealtimeEngine] do not delete room %s', id);
        return;
      }

      debug('[hotelClerk._removeRoomFromRealtimeEngine] delete room %s', id);
      return this.kuzzle.hotelClerk.constructor.prototype
        ._removeRoomFromRealtimeEngine.call(this.kuzzle.hotelClerk, id);
    };

    // register existing strategies
    const promises = [];
    for (const name of this.kuzzle.pluginsManager.listStrategies()) {
      const strategy = this.kuzzle.pluginsManager.strategies[name];

      promises.push(
        this.redis.hset(
          'cluster:strategies',
          name,
          JSON.stringify({
            plugin: strategy.owner,
            strategy: strategy.strategy
          })));
    }

    return Bluebird.all(promises)
      .then(() => {
        this._isKuzzleStarted = true;
        return this.node.init();
      });
  }

  notifyDocument (data) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast document notification: node not connected to cluster', this.uuid);
      return;
    }

    this.node.broadcast('cluster:notify:document', data);
  }

  notifyUser (data) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast user notification: node not connected to cluster', this.uuid);
      return;
    }

    this.node.broadcast('cluster:notify:user', data);
  }

  /**
   * @param {object} diff
   */
  profileUpdated (diff) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "profile update" action: node not connected to cluster', this.uuid);
      return;
    }

    this.node.broadcast('cluster:sync', {
      event: 'profile',
      id: diff._id
    });
  }

  refreshSpecifications () {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "refresh specifications" action: node not connected to cluster', this.uuid);
      return;
    }

    this.node.broadcast('cluster:sync', {
      event: 'validators'
    });
  }

  /**
   * @param {object} diff
   */
  roleUpdated (diff) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "role update" action: node not connected to cluster', this.uuid);
      return;
    }

    this.node.broadcast('cluster:sync', {
      event: 'role',
      id: diff._id
    });
  }

  roomCreated (payload) {
    this.node.state.locks.create.add(payload.roomId);
  }

  roomDeleted (roomId) {
    this.node.state.locks.delete.add(roomId);
  }

  strategyAdded (payload) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "strategy added" action: node not connected to cluster', this.uuid);
      return Bluebird.resolve(payload);
    }

    return this.redis
      .hset('cluster:strategies', payload.name, JSON.stringify({
        plugin: payload.pluginName,
        strategy: payload.strategy
      }))
      .then(() => this.node.broadcast('cluster:sync', {event: 'strategies'}))
      .then(() => payload);
  }

  strategyRemoved (payload) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "strategy added" action: node not connected to cluster', this.uuid);
      return Bluebird.resolve(payload);
    }

    return this.redis.hdel('cluster:strategies', payload.name)
      .then(() => this.node.broadcast('cluster:sync', {event: 'strategies'}))
      .then(() => payload);
  }

  subscriptionAdded (diff) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "subscription added" action: node not connected to cluster', this.uuid);
      return Bluebird.resolve(diff);
    }

    const
      {
        index,
        collection,
        filters,
        roomId,
        connectionId
      } = diff,
      filter = {index, collection, filters},
      serializedFilter = filters && JSON.stringify(filter) || 'none';

    debug('[hook] sub add %s/%s', roomId, connectionId);

    let result;
    return this.redis
      .clusterSubOn(
        `{${index}/${collection}}`,
        this.uuid,
        roomId,
        connectionId,
        serializedFilter)
      .then(r => {
        result = r;
        return this.redis.sadd('cluster:collections', `${index}/${collection}`);
      })
      .then(() => this._onSubOn('add', index, collection, roomId, result))
      .then(() => diff)
      .finally(() => this.node.state.locks.create.delete(roomId));
  }

  subscriptionJoined (diff) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "subscription joined" action: node not connected to cluster', this.uuid);
      return Bluebird.resolve(diff);
    }

    const
      {
        index,
        collection,
        roomId,
        connectionId
      } = diff;

    if (diff.changed === false) {
      debug('[hook][sub joined] no change');
      return Bluebird.resolve(diff);
    }

    return this.redis
      .clusterSubOn(
        `{${index}/${collection}}`,
        this.uuid,
        roomId,
        connectionId,
        'none')
      .then(result => this._onSubOn('join', index, collection, roomId, result))
      .then(() => diff);
  }

  subscriptionOff (object) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "subscription off" action: node not connected to cluster', this.uuid);
      return Bluebird.resolve(object);
    }

    const
      room = object.room,
      {index, collection} = room,
      connectionId = object.requestContext.connectionId;

    debug('[hook] sub off %s/%s', room.id, connectionId);

    return this.redis
      .clusterSubOff(
        `{${room.index}/${room.collection}}`,
        this.uuid,
        room.id,
        connectionId)
      .then(result => {
        const [version, count] = result;

        if (this.node.state.getVersion(index, collection) < version) {
          this.setRoomCount(index, collection, room.id, count);
        }

        debug(
          '[hook][sub off] v%d %s/%s/%s -%s = %d',
          version,
          index,
          collection,
          room.id,
          connectionId,
          count);

        return this.node.broadcast('cluster:sync', {
          index,
          collection,
          roomId: room.id,
          event: 'state',
          post: 'off'
        });
      })
      .then(() => object)
      .finally(() => this.node.state.locks.delete.delete(room.id));
  }

  /**
   * @param {Request} request
   */
  unlockCreateRoom (request) {
    // incoming request can be invalid. We need to check for its params
    if (!request.input.body || !request.input.body.roomId) {
      return;
    }

    this.node.state.locks.create.delete(request.input.body.roomId);
  }

  /**
   * @param {Request} request
   */
  unlockDeleteRoom (request) {
    // incoming request can be invalid. We need to check for its params
    if (!request.input.body || !request.input.body.roomId) {
      return;
    }

    this.node.state.locks.delete.delete(request.input.body.roomId);
  }

  resetSecurityCache () {
    this.node.broadcast('cluster:admin:resetSecurity');
  }

  dump (request) {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "dump" action: node not connected to cluster', this.uuid);
      return;
    }

    const suffix = request.input.args.suffix || '';

    this.node.broadcast('cluster:admin:dump', { suffix });
  }

  shutdown () {
    if (!this.node.ready) {
      debug('[%s][warning] could not broadcast "shutdown" action: node not connected to cluster', this.uuid);
      return;
    }

    this.node.broadcast('cluster:admin:shutdown');
  }

  // --------------------------------------------------------------------------
  // business
  // --------------------------------------------------------------------------
  /**
   * Removes cluster related data inserted in redis from nodeId
   *
   * @param {string} nodeId
   */
  cleanNode (node) {
    const promises = [];

    return this.redis
      .srem('cluster:discovery', JSON.stringify({
        pub: node.pub,
        router: node.router
      }))
      .then(() => {
        if (node === this.node && this.node.pool.size === 0) {
          debug('last node to quit.. cleaning up');
          return this.node.state.reset();
        }

        for (const [index, collections] of this._rooms.tree.entries()) {
          for (const collection of collections.keys()) {
            promises.push(
              this.redis.clusterCleanNode(
                `{${index}/${collection}}`,
                node.uuid));
          }
        }

        return Bluebird.all(promises);
      })
      .then(() => this.node.broadcast('cluster:sync', {event: 'state:all'}));
  }

  deleteRoomCount (roomId) {
    const room = this._rooms.flat.get(roomId);
    if (!room) {
      return;
    }

    const { index, collection } = room;

    this._rooms.flat.delete(roomId);

    const
      collections = this._rooms.tree.get(index),
      rooms = collections.get(collection);

    rooms.delete(roomId);

    if (rooms.size === 0) {
      collections.delete(collection);

      if (collections.size === 0) {
        this._rooms.tree.delete(index);
      }
    }
  }

  log (level, msg) {
    if (this._isKuzzleStarted) {
      this.kuzzle.emit(`log:${level}`, msg);
    }
    else {
      // eslint-disable-next-line no-console
      console.log(`${new Date().toISOString()} [${level}] ${msg}`);
    }
  }

  reset () {
    return this.node.state.reset()
      .then(() => this.node.state.syncAll({post: 'reset'}))
      .then(() => {
        this._rooms.flat.clear();
        this._rooms.tree.clear();
      });
  }

  setRoomCount (index, collection, roomId, _count) {
    const count = parseInt(_count, 10);

    if (count === 0) {
      return this.deleteRoomCount(roomId);
    }

    const val = {
      index,
      collection,
      count
    };

    this._rooms.flat.set(roomId, val);

    let collections = this._rooms.tree.get(index);

    if (!collections) {
      collections = new Map();
      this._rooms.tree.set(index, collections);
    }

    if (!collections.has(collection)) {
      collections.set(collection, new Set());
    }

    collections.get(collection).add(roomId);
  }

  _onSubOn (type, index, collection, roomId, result) {
    const [version, count] = result;

    if (this.node.state.getVersion(index, collection) < version) {
      this.setRoomCount(index, collection, roomId, count);
    }

    debug('[hook][sub %s] v%d %s/%s/%s = %d',
      type,
      version,
      index,
      collection,
      roomId,
      count);

    return this.node.broadcast('cluster:sync', {
      index,
      collection,
      roomId,
      event: 'state',
      post: type
    });
  }

  _onShutDown (event) {
    if (this._shutdown) {
      return;
    }

    this._shutdown = true;
    this.log('warn', event + ' kuzzle is shutting down... doing our best to clean rooms');

    return this.cleanNode(this.node);
  }

  /**
   * @param {Request} request
   * @param {number} attempt
   * @private
   */
  _realtimeCountOverride (request, attempt = 0) {
    if (!request.input.body) {
      return Bluebird.reject(new this.context.errors.BadRequestError('The request must specify a body.'));
    }

    if (!Object.prototype.hasOwnProperty.call(request.input.body, 'roomId')) {
      return Bluebird.reject(new this.context.errors.BadRequestError('The request must specify a body attribute "roomId".'));
    }

    const roomId = request.input.body.roomId;

    if (!this._rooms.flat.has(roomId)) {
      // no room found. May be normal but can also be due to cluster replication
      // time
      if (attempt > 0) {
        return Bluebird.reject(new this.context.errors.NotFoundError(`The room Id "${roomId}" does not exist`));
      }

      return Bluebird
        .delay(this.config.timers.waitForMissingRooms)
        .then(() => this._realtimeCountOverride(request, attempt + 1));
    }

    return Bluebird.resolve({count: this._rooms.flat.get(roomId).count});
  }

  /**
   * @param {Request} request
   * @private
   */
  _realtimeListOverride (request) {
    const list = {};

    const promises = [];

    for (const [roomId, room] of this._rooms.flat.entries()) {
      promises.push(request.context.user.isActionAllowed(new Request({
        controller: 'document',
        action: 'search',
        index: room.index,
        collection: room.collection
      }), this.kuzzle)
        .then(isAllowed => {
          if (!isAllowed) {
            return;
          }

          if (!list[room.index]) {
            list[room.index] = {};
          }
          if (!list[room.index][room.collection]) {
            list[room.index][room.collection] = {};
          }
          list[room.index][room.collection][roomId] = room.count;
        })
      );
    }

    return Bluebird.all(promises)
      .then(() => {
        if (!request.input.args.sorted) {
          return list;
        }

        const sorted = {};

        for (const index of Object.keys(list).sort()) {
          if (!sorted[index]) {
            sorted[index] = {};
          }

          for (const collection of Object.keys(list[index]).sort()) {
            if (!sorted[index][collection]) {
              sorted[index][collection] = {};
            }

            for (const roomId of Object.keys(list[index][collection]).sort()) {
              sorted[index][collection][roomId] = list[index][collection][roomId];
            }
          }
        }

        return sorted;
      });
  }

  _registerShutdownListeners () {
    for (const event of [
      'uncaughtException',
      'SIGINT',
      'SIGQUIT',
      'SIGABRT',
      'SIGTERM'
    ]) {
      process.on(event, () => this._onShutDown(event));
    }

    // Crashing on an unhandled rejection is a good idea during development
    // as it helps spotting code errors. And according to the warning messages,
    // this is what Node.js will do automatically in future versions anyway.
    if (process.env.NODE_ENV === 'development') {
      process.on('unhandledRejection', () => {
        this.log('error', 'Kuzzle caught an unhandled rejected promise and will shutdown.');
        this.log('error', 'This behavior is only triggered if NODE_ENV is set to "development"');
        this._onShutDown('unhandledRejection');
      });
    }
  }
}

module.exports = KuzzleCluster;