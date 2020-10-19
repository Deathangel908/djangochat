import {IStorage, SetRoomsUsers, StorageData} from '@/types/types';
import loggerFactory from '@/utils/loggerFactory';
import {Logger} from 'lines-logger';
import {
  CurrentUserInfoModel,
  CurrentUserSettingsModel, FileModel,
  MessageModel, RoomDictModel, RoomModel,
  RoomSettingsModel,
  UserModel
} from '@/types/model';
import {
  convertNumberToSex,
  convertSexToNumber,
  convertSexToString,
  convertStringSexToNumber, convertToBoolean, getRoomsBaseDict
} from '@/types/converters';
import {browserVersion} from '@/utils/singletons';
import {
  FileDB, MessageDB,
  ProfileDB,
  RoomDB,
  RoomUsersDB,
  SettingsDB, TransactionType,
  UserDB
} from '@/types/db';

type TransactionCb = (t: SQLTransaction, ...rest: unknown[]) => void;

export default class DatabaseWrapper implements IStorage {
  private readonly logger: Logger;
  private readonly dbName: String;
  private db: Database|null = null;
  private readonly cache: { [id: number]: number } = {};

  constructor(dbName: String) {
    this.logger = loggerFactory.getLoggerColor('db', '#753e01');
    this.dbName = dbName;
  }

  public async connect(): Promise<boolean> {
    this.db = window.openDatabase(this.dbName, '', 'Messages database', 10 * 1024 * 1024);
    if (this.db.version === '') {
      this.logger.log('Initializing database')();
      let t: SQLTransaction = await new Promise<SQLTransaction>((resolve, reject) => {
        this.db!.changeVersion(this.db!.version, '1.0', resolve, reject);
      });
      t = await this.runSql(t, 'CREATE TABLE user (id integer primary key, user text, sex integer NOT NULL CHECK (sex IN (0,1,2)), deleted boolean NOT NULL CHECK (deleted IN (0,1)), country_code text, country text, region text, city text)');
      t = await this.runSql(t, 'CREATE TABLE room (id integer primary key, name text, notifications boolean NOT NULL CHECK (notifications IN (0,1)), volume integer, deleted boolean NOT NULL CHECK (deleted IN (0,1)))');
      t = await this.runSql(t, 'CREATE TABLE message (id integer primary key, time integer, content text, symbol text, deleted boolean NOT NULL CHECK (deleted IN (0,1)), giphy text, edited integer, roomId integer REFERENCES room(id), userId integer REFERENCES user(id), sending boolean NOT NULL CHECK (deleted IN (0,1)))');
      t = await this.runSql(t, 'CREATE TABLE file (id integer primary key, symbol text, url text, message_id INTEGER REFERENCES message(id) ON UPDATE CASCADE , type text, preview text)');
      t = await this.runSql(t, 'CREATE TABLE settings (userId integer primary key, embeddedYoutube boolean NOT NULL CHECK (embeddedYoutube IN (0,1)), highlightCode boolean NOT NULL CHECK (highlightCode IN (0,1)), incomingFileCallSound boolean NOT NULL CHECK (incomingFileCallSound IN (0,1)), messageSound boolean NOT NULL CHECK (messageSound IN (0,1)), onlineChangeSound boolean NOT NULL CHECK (onlineChangeSound IN (0,1)), sendLogs boolean NOT NULL CHECK (sendLogs IN (0,1)), suggestions boolean NOT NULL CHECK (suggestions IN (0,1)), theme text, logs boolean NOT NULL CHECK (logs IN (0,1)))');
      t = await this.runSql(t, 'CREATE TABLE profile (userId integer primary key, user text, name text, city text, surname text, email text, birthday text, contacts text, sex integer NOT NULL CHECK (sex IN (0,1,2)))');
      t = await this.runSql(t, 'CREATE TABLE room_users (room_id INTEGER REFERENCES room(id), user_id INTEGER REFERENCES user(id))');
      this.logger.log('DatabaseWrapper has been initialized')();

      return true;
    } else if (this.db.version === '1.0') {
      this.logger.log('Created new db connection')();

      return false;
    }

    return false;
  }

  public async getAllTree(): Promise<StorageData|null> {
    const t: SQLTransaction = await this.asyncWrite();
    const f: unknown[][] = await Promise.all<unknown[]>([
      'select * from file',
      'select * from profile',
      'select * from room where deleted = 0',
      'select * from room_users',
      'select * from settings',
      'select * from user where deleted = 0',
      'select * from message'
    ].map(sql => new Promise((resolve, reject) => {
      this.executeSql(t, sql, [], (t: SQLTransaction, d: SQLResultSet) => {
        this.logger.trace('sql {} fetched {} ', sql, d)();
        const res: unknown[] = [];
        for (let i = 0; i < d.rows.length; i++) {
          const rows: SQLResultSetRowList = d.rows;
          res.push(rows.item(i)); // TODO does that work
        }
        resolve(res);
      },              (t: SQLTransaction, e: SQLError) => {
        reject(e);

        return false;
      })();
    })));

    const dbFiles: FileDB[] = f[0] as FileDB[],
        dbProfile: ProfileDB[] = f[1] as ProfileDB[],
        dbRooms: RoomDB[] = f[2] as RoomDB[],
        dbRoomUsers: RoomUsersDB[] = f[3] as RoomUsersDB[],
        dbSettings: SettingsDB[] = f[4] as SettingsDB[],
        dbUsers: UserDB[] = f[5] as UserDB[],
        dbMessages: MessageDB[] = f[6] as MessageDB[];
    this.logger.debug('resolved all sqls')();

    if (dbProfile.length) {
      const profile: CurrentUserInfoModel = {
        sex: convertSexToString(dbProfile[0].sex),
        contacts: dbProfile[0].contacts,
        birthday: dbProfile[0].birthday,
        email: dbProfile[0].email,
        surname: dbProfile[0].surname,
        city: dbProfile[0].city,
        name: dbProfile[0].name,
        userId: dbProfile[0].userId,
        user: dbProfile[0].user
      };
      const settings: CurrentUserSettingsModel = {
        embeddedYoutube: convertToBoolean(dbSettings[0].embeddedYoutube),
        highlightCode: convertToBoolean(dbSettings[0].highlightCode),
        incomingFileCallSound: convertToBoolean(dbSettings[0].incomingFileCallSound),
        messageSound: convertToBoolean(dbSettings[0].messageSound),
        onlineChangeSound: convertToBoolean(dbSettings[0].onlineChangeSound),
        sendLogs: convertToBoolean(dbSettings[0].sendLogs),
        suggestions: convertToBoolean(dbSettings[0].suggestions),
        theme: dbSettings[0].theme,
        logs: convertToBoolean(dbSettings[0].logs)
      };
      const roomsDict: RoomDictModel = {};
      dbRooms.forEach((r: RoomDB) => {
        const rm: RoomModel = getRoomsBaseDict({
          roomId: r.id,
          notifications: convertToBoolean(r.notifications),
          name: r.name,
          users: [],
          volume: r.volume
        });
        roomsDict[r.id] = rm;
      });
      dbRoomUsers.forEach(ru => {
        roomsDict[ru.room_id].users.push(ru.user_id);
      });
      const allUsersDict: { [id: number]: UserModel } = {};
      dbUsers.forEach(u => {
        const user: UserModel = {
          id: u.id,
          sex: convertNumberToSex(u.sex),
          user: u.user,
          location: {
            region: u.region,
            city: u.city,
            countryCode: u.country_code,
            country: u.country
          }
        };
        allUsersDict[u.id] = user;
      });

      const am: { [id: string]: MessageModel } = {};
      const sendingMessages: MessageModel[] = [];
      dbMessages.forEach(m => {
        const message: MessageModel = {
          id: m.id,
          roomId: m.roomId,
          time: m.time,
          deleted: convertToBoolean(m.deleted),
          transfer: m.sending ? {
            error: null,
            upload: null
          } : null,
          files: {},
          edited: m.edited,
          symbol: m.symbol,
          content: m.content,
          userId: m.userId,
          giphy: m.giphy
        };
        if (m.sending) {
          sendingMessages.push(message);
        }
        if (roomsDict[m.roomId]) {
          roomsDict[m.roomId].messages[m.id] = message;
        }
        am[m.id] = message;
      });
      dbFiles.forEach(f => {
        const amElement: MessageModel = am[f.message_id];
        if (amElement) {
          const file: FileModel = {
            url: f.url,
            type: f.type,
            preview: f.preview,
            id: f.id
          };
          amElement.files![f.symbol] = file;
        }
      });

      return {sendingMessages, setRooms: {roomsDict, settings, profile, allUsersDict}};
    } else {
      return null;
    }
  }

  // public getRoomHeaderId (id: number, cb: Function) {
  //   this.read((t, id, cb ) => {
  //     this.executeSql(t, 'select min(id) as min from message where roomId = ?', [id], (t, d) => {
  //       cb(d.rows.length ? d.rows[0].min : null);
  //     });
  //   });
  // }

  // public getIds (cb) {
  //   this.read(t => {
  //     this.executeSql(t, 'select max(id) as max, roomId, min(id) as min from message group by roomId', [],  (t, d) => {
  //       let res = {};
  //       for (let i = 0; i < d.rows.length; i++) {
  //         let e = d.rows[i];
  //         res[e.roomId] = {h: e.min, f: this.cache[e.roomId] || e.max};
  //       }
  //       cb(res);
  //     });
  //   });
  // }

  public async clearMessages() {
    let t: SQLTransaction = await this.asyncWrite();
    t = await this.runSql(t, 'delete from file');
    t = await this.runSql(t, 'delete from message');
    this.logger.log('Db has messages removed')();
  }

  public clearStorage() {
    this.write(t => {
      this.executeSql(t, 'delete from room_users')();
      this.executeSql(t, 'delete from user')();
      this.executeSql(t, 'delete from room')();
      this.executeSql(t, 'delete from file')();
      this.executeSql(t, 'delete from message')();
      this.executeSql(t, 'delete from settings')();
      this.executeSql(t, 'delete from profile')();
      this.logger.log('Db has been cleared')();
    });
  }

  // private getMessages (t, cb) {
  //   this.executeSql(t, 'SELECT * FROM message', [], (t, m) => {
  //     this.executeSql(t, 'SELECT * from file', [],  (t, i) => {
  //       let mid = {};
  //       let messages = [];
  //       for (let j = 0; j < m.rows.length; j++) {
  //         let e = m.rows[j];
  //         mid[e.id] = e;
  //         e.files = {};
  //         messages.push(e);
  //       }
  //       for (let j = 0; j < i.rows.length; j++) {
  //         let e = i.rows[j];
  //         mid[e.message_id].files[e.symbol] = e;
  //       }
  //       cb(messages);
  //     })();
  //   })();
  //   return cb;
  // }

  public insertMessage(t: SQLTransaction, message: MessageModel) {
    this.setRoomHeaderId(message.roomId, message.id);
    this.executeSql(t, 'insert or replace into message (id, time, content, symbol, deleted, giphy, edited, roomId, userId, sending) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [message.id, message.time, message.content, message.symbol || null, message.deleted ? 1 : 0, message.giphy || null, message.edited, message.roomId, message.userId, message.transfer ? 1 : 0], (t, d) => {
          for (const k in message.files) {
            const f = message.files[k];
            this.executeSql(t, 'insert or replace into file (id, symbol, url, message_id, type, preview) values (?, ?, ?, ?, ?, ?)', [f.id, k, f.url, message.id, f.type, f.preview])();
          }
        })();
  }

  public saveRoom(room: RoomModel) {
    this.write((t: SQLTransaction) => {
      this.setRoom(t, room);
      this.setRoomUsers(t, room.id, room.users);
    });
  }

  public setRooms(rooms: RoomModel[]) {
    this.write(t => {
      this.executeSql(t, 'update room set deleted = 1', [], (t) => {
        rooms.forEach(r => this.setRoom(t, r));
      })();
      this.executeSql(t, 'delete from room_users', [], (t) => {
        rooms.forEach(r => {
          r.users.forEach(u => {
            this.insertRoomUsers(t, r.id, u);
          });
        });
      })();
    });
  }

  public insertUser(t: SQLTransaction, user: UserModel) {
    this.executeSql(t, 'insert or replace into user (id, user, sex, deleted, country_code, country, region, city) values (?, ?, ?, 0, ?, ?, ?, ?)', [user.id, user.user, convertSexToNumber(user.sex), user.location.countryCode, user.location.country, user.location.region, user.location.city])();
  }

  public saveUser(user: UserModel) {
    this.write(t => this.insertUser(t, user));
  }

  public setUsers(users: UserModel[]) {
    this.write(t => {
      this.executeSql(t, 'update user set deleted = 1', [])();
      users.forEach(u => this.insertUser(t, u));
    });
  }

  public setUserProfile(user: CurrentUserInfoModel) {
    this.write(t => {
      this.executeSql(t, 'insert or replace into profile (userId, user, name, city, surname, email, birthday, contacts, sex) values (?, ?, ?, ?, ?, ?, ?, ?, ?)', [user.userId, user.user, user.name, user.city, user.surname, user.email, user.birthday, user.contacts, convertStringSexToNumber(user.sex)])();
    });
  }

  public setUserSettings(settings: CurrentUserSettingsModel) {
    this.write(t => {
      this.executeSql(t, 'insert or replace into settings (userId, embeddedYoutube, highlightCode, incomingFileCallSound, messageSound, onlineChangeSound, sendLogs, suggestions, theme, logs) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [1, settings.embeddedYoutube ? 1 : 0, settings.highlightCode ? 1 : 0, settings.incomingFileCallSound ? 1 : 0, settings.messageSound ? 1 : 0, settings.onlineChangeSound ? 1 : 0, settings.sendLogs ? 1 : 0, settings.suggestions ? 1 : 0, settings.theme, settings.logs ? 1 : 0])();
    });
  }

  public deleteMessage(id: number) {
    this.write(t => {
      this.executeSql(t, 'delete from file where message_id = ?', [id], (t) => {
        this.executeSql(t, 'delete from message where id = ? ', [id])();
      });
    });
  }

  public deleteRoom(id: number) {
    this.write(t => {
      this.executeSql(t, 'update room set deleted = 1 where id = ? ', [id])();
      this.executeSql(t, 'delete from room_users where room_id = ? ', [id])();
    });
  }

  public saveRoomUsers(ru: SetRoomsUsers) {
    this.write((t: SQLTransaction) => {
      this.setRoomUsers(t, ru.roomId, ru.users);
    });
  }

  public updateRoom(r: RoomSettingsModel) {
    this.write(t => {
      this.executeSql(t, 'update room set name = ?, volume = ?, notifications = ? where id = ? ', [r.name, r.volume, r.notifications ? 1 : 0, r.id])();
    });
  }

  public saveMessages(messages: MessageModel[]) {
    this.write(t => {
      messages.forEach(m => {
        this.insertMessage(t, m);
      });
    });
  }

  public saveMessage(m: MessageModel) {
    this.write(t => {
      this.insertMessage(t, m);
    });
  }

  public setRoomHeaderId(roomId: number, headerId: number) {
    if (!this.cache[roomId] || this.cache[roomId] < headerId) {
      this.cache[roomId] = headerId;
    }
  }

  private executeSql(
      t: SQLTransaction,
      sql: string,
      args: unknown[] = [],
      cb: SQLStatementCallback | undefined = undefined,
      e: SQLStatementErrorCallback | undefined = undefined
  ): Function {
    const err: SQLStatementErrorCallback = e ? e : (t: SQLTransaction, e: SQLError)  => {
      this.logger.error('{} {}, error: {}, message {}', sql, args, e, e && e.message)();

      return false;
    };
    t.executeSql(sql, args, cb, err);

    return this.logger.trace('{} {}', sql, args);
  }

  private async runSql(t: SQLTransaction, sql: string): Promise<SQLTransaction> {
    return new Promise<SQLTransaction>((resolve, reject) => {
      this.executeSql(t, sql, [], resolve, (t: SQLTransaction, e: SQLError) => {
        reject({sql, e});

        return false;
      });
    });
  }

  private getStart() {
    return Promise.resolve().then(() => new Promise((resolve, reject) => {
      this.db!.changeVersion(this.db!.version, '1.0', resolve, reject);
    }));
  }

  private transaction(transactionType: TransactionType, cb: TransactionCb) {
    if (!this.db) { // TODO TypeError: undefined is not an object (evaluating 'this.db[transactionType]')
      throw Error(`${browserVersion} failed to get db`);
    }
    this.db[transactionType](t => {
      cb(t);
    },                       (e) => {
      this.logger.error('Error during saving message {}', e)();
    });
  }

  private write(cb: TransactionCb) {
    return this.transaction('transaction', cb);
  }

  private async asyncWrite(): Promise<SQLTransaction> {
    return new Promise<SQLTransaction>((resolve, reject) => {
      this.write(resolve);
    });
  }

  private setRoom(t: SQLTransaction, room: RoomSettingsModel) {
    this.executeSql(t, 'insert or replace into room (id, name, notifications, volume, deleted) values (?, ?, ?, ?, ?)', [room.id, room.name, room.notifications ? 1 : 0, room.volume, 0])();
  }

  private insertRoomUsers(t: SQLTransaction, roomId: number, userId: number) {
    this.executeSql(t, 'insert into room_users (room_id, user_id) values (?, ?)', [roomId, userId])();
  }

  private setRoomUsers(t: SQLTransaction, roomId: number, users: number[]) {
    this.executeSql(t, 'delete from room_users where room_id = ?', [roomId], t => {
      users.forEach(u => {
        this.insertRoomUsers(t, roomId, u);
      });
    })();
  }

}
