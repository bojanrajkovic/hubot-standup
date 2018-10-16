const countdown = require("countdown");
const moment = require("moment");
const { knuthShuffle } = require("knuth-shuffle");
const sqlite = require("sqlite");
const SQL = require("sql-template-strings");
const path = require("path");
const toTitleCase = require("to-title-case");

const dbPromise = sqlite.open(process.env.STANDUP_DATABASE_PATH || "standup.sqlite", { Promise });
dbPromise.then(database => {
    database.migrate({ force: "last", migrationsPath: path.resolve(__dirname, "migrations") });
}).catch(err => {
    console.log(`Could not open database: ${err}.`);
});

module.exports = (robot) => {
    robot.brain.data.standup = robot.brain.data.standup || {};

    robot.respond(/(?:cancel|stop) standup *$/i, (msg) => {
        if (robot.brain.data.standup[msg.message.user.room])
            delete robot.brain.data.standup[msg.message.user.room];
        msg.reply("Cancelled standup.");
    });

    robot.respond(/standup for (.*?) *$/i, async (msg) => {
        const room = msg.message.user.room;
        const team = msg.match[1].trim();
        const standup = robot.brain.data.standup[room];

        if (standup) {
            msg.reply(`${room} is already hosting a standup for ${standup[room].team}`);
            return;
        }

        let attendees = robot.auth.usersWithRole(team).map(userName => {
            return robot.brain.userForName(userName);
        });
        if (attendees.length > 0) {
            robot.brain.data.standup[room] = {
                team,
                start: new Date().getTime(),
                attendees,
                remaining: knuthShuffle(attendees.slice(0))
            };
            robot.logger.debug(attendees);
            const who = attendees.map(user => addressUser(user, robot.adapter)).join(", ");
            msg.send(`OK, let's start the standup: ${who}`);
            await nextPerson(robot, room, msg);
        } else {
            msg.reply(`Can't find any ${team} members for a standup.`);
            return;
        }
    });

    robot.hear(/(?:that\'s it|next(?: person)?|done|pass) *$/i, async (msg) => {
        const room = msg.message.user.room;
        if (!robot.brain.data.standup[room])
            return;

        if (robot.brain.data.standup[room].current.id !== msg.message.user.id)
            msg.reply("It's not your turn! Tell me to skip [someone] or next [someone] instead.");
        else
            await nextPerson(robot, room, msg);
    });

    robot.respond(/(skip|next) (.*?) *$/i, async (msg) => {
        const room = msg.message.user.room;
        const standup = robot.brain.data.standup[room];
        const isSkip = msg.match[1] === "skip";
        
        if (!standup)
            return;

        const users = robot.brain.usersForFuzzyName(msg.match[2]);
        if (users.length === 1) {
            const skip = users[0]
            if (isSkip) {
                standup.remaining.filter(user => {
                    return user.name !== skip.name;
                });
                if (standup.current.id === skip.id)
                    await nextPerson(robot, room, msg);
                else
                    msg.reply(`OK, I'll skip ${skip.name}.`);
            } else {
                if (standup.current.id === skip.id) {
                    standup.remaining.push(skip);
                    await nextPerson(robot, room, msg);
                } else {
                    msg.reply(`It's not ${skip.name}'s turn!`)
                }
            }
        } else if (users.length > 1) {
            msg.reply(
                `Be more specific, I know ${users.length} people with similar names: ` + 
                users.map(user => user.name).join(', ')
            );
        } else {
            msg.reply(`${msg.match[2]}? Never heard of them.`);
        }
    });

    robot.respond(/standup\?? *$/i, (msg) => {
        msg.send(
            "standup for <team> - start the standup for <team>",
            "cancel standup - cancel the current standup",
            "next - say when your updates for the standup is done",
            "skip <who> - skip someone when they're not available"
        );
    });

    robot.respond(/email (.*?) logs from (\d{4}\-(0[1-9]|1[012])\-(0[1-9]|[12][0-9]|3[01])) to ((([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,})))$/, (msg) => {
        msg.reply(`going to send ${msg.match[1]} logs from ${msg.match[2]} to ${msg.match[5]}`);
    });

    robot.catchAll(async (msg) => {
        const user = msg.message.user;
        const room = user.room;
        const standup = robot.brain.data.standup[room];

        if (!standup)
            return;

        if (standup.current.id !== user.id) {
            robot.logger.warning(`Ignoring ${user.name} speaking out of turn during standup in ${room}.`);
            return;
        }

        standup.log = standup.log || {};
        standup.log[user.name] = standup.log[user.name] || [];
        standup.log[user.name].push({
            message: msg.message.text,
            time: Date.now()
        });
    })
};

async function nextPerson(robot, room, msg) {
    const standup = robot.brain.data.standup[room];

    if (!standup) {
        robot.logger.error(`Could not find standup for ${room}.`);
        return;
    }

    if (standup.remaining.length === 0) {
        const howLong = countdown(standup.start, Date.now()).toString()
        msg.send(`All done! Standup was ${howLong}.`);

        const dbStandup = {
            id: `${standup.team}-${moment(standup.start).format("YYYY-MM-DD")}`,
            end: Date.now(),
            start: standup.start,
            duration: howLong,
            date: moment(standup.start).format("LL"),
            log: standup.log,
            attendees: standup.attendees,
            team: toTitleCase(standup.team)
        }

        robot.logger.debug(JSON.stringify(dbStandup));
        await insertStandupIntoDb(dbStandup);
        msg.send("Saved standup results to database!");

        delete robot.brain.data.standup[room];
    } else {
        standup.current = standup.remaining.shift();
        msg.send(
            `${addressUser(standup.current, robot.adapter)}, it's your turn! ` +
            "Tell us what you did yesterday, what you're working on today, and " +
            "any issues you've run into/are blocked on."
        );
    }
}

async function insertStandupIntoDb(dbStandup) {
    try {
        const db = await dbPromise;
        await db.run(SQL`
            INSERT INTO Standup(name, start, end, team)
            VALUES(${dbStandup.id}, ${dbStandup.start}, ${dbStandup.end}, ${dbStandup.team});
        `);
        const standupId = (await db.get("SELECT last_insert_rowid() AS standupId"))["standupId"];
        for (const attendee of dbStandup.attendees) {
            console.dir(attendee);
            await db.run(SQL`
                INSERT INTO Attendee(standupId, userId, name)
                VALUES(${standupId}, ${attendee.id}, ${attendee.name})
            `);
            const attendeeId = (await db.get("SELECT last_insert_rowid() AS attendeeId"))["attendeeId"];
            const logs = dbStandup.log[attendee.name];
            console.dir(logs);
            for (var logEntry of logs) {
                await db.run(SQL`
                    INSERT INTO LogEntry(standupId, attendeeId, time, message)
                    VALUES(${standupId}, ${attendeeId}, ${logEntry.time}, ${logEntry.message})
                `);
            }
        }
    } catch (e) {
        console.log("Error doing database stuff: " + e);
    }
}

function addressUser(user, adapter) {
    const className = adapter.__proto__.constructor.name;
    if (className.includes("Slack"))
        return `<@${user.id}>`;
    else
        return `@${user.name}`;
}
