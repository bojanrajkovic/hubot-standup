 how logs are # Description:
#   Agile standup bot ala tender
#
# Commands:
#   hubot standup? - show help for the standup
#   hubot <who> is a member of <team> - tell hubot who is the member of <team>'s standup
#   hubot standup for <team> - start the standup for <team>
#   hubot cancel standup - cancel the current standup
#   hubot next - say when your updates for the standup is done
#   hubot skip <who> - skip someone when they're not available
#
# Author:
#   @miyagawa

countdown = require "countdown"
moment = require "moment"
mongojs = require "mongojs"
util = require "util"

module.exports = (robot) ->
  mongo_uri = process.env.MONGOLAB_URI
  mongo_collections = ["standups"]
  db = mongojs(mongo_uri, mongo_collections)

  robot.respond /(?:cancel|stop) standup *$/i, (msg) ->
    delete robot.brain.data.standup?[msg.message.user.room]
    msg.send "Standup cancelled"

  robot.respond /standup for (.*?) *$/i, (msg) ->
    room  = msg.message.user.room
    group = msg.match[1].trim()
    if robot.brain.data.standup?[room]
      msg.send "The standup for #{robot.brain.data.standup[room].group} is in progress! Cancel it first with 'cancel standup'"
      return

    attendees = []
    for own key, user of robot.brain.data.users
      roles = user.roles or [ ]
      if "a #{group} member" in roles or "an #{group} member" in roles or "a member of #{group}" in roles
        attendees.push user
    if attendees.length > 0
      robot.brain.data.standup or= {}
      robot.brain.data.standup[room] = {
        group: group,
        start: new Date().getTime(),
        attendees: attendees,
        remaining: shuffleArrayClone(attendees)
        log: [],
      }
      who = attendees.map((user) -> addressUser(user, robot.adapter)).join(', ')
      msg.send "Ok, let's start the standup: #{who}"
      nextPerson robot, db, room, msg
    else
      msg.send "Oops, can't find anyone with 'a #{group} member' role!"

  robot.respond /(?:that\'s it|next(?: person)?|done) *$/i, (msg) ->
    unless robot.brain.data.standup?[msg.message.user.room]
      return
    if robot.brain.data.standup[msg.message.user.room].current.id isnt msg.message.user.id
      msg.reply "but it's not your turn! Use skip [someone] or next [someone] instead."
    else
      nextPerson robot, db, msg.message.user.room, msg

  robot.respond /(skip|next) (.*?) *$/i, (msg) ->
    unless robot.brain.data.standup?[msg.message.user.room]
      return

    is_skip = msg.match[1] == 'skip'
    users = robot.brain.usersForFuzzyName msg.match[2]
    if users.length is 1
      skip = users[0]
      standup = robot.brain.data.standup[msg.message.user.room]
      if is_skip
        standup.remaining = (user for user in standup.remaining when user.name != skip.name)
        if standup.current.id is skip.id
          nextPerson robot, db, msg.message.user.room, msg
        else
          msg.send "Ok, I will skip #{skip.name}"
      else
        if standup.current.id is skip.id
          standup.remaining.push skip
          nextPerson robot, db, msg.message.user.room, msg
        else
          msg.send "But it is not #{skip.name}'s turn!"
    else if users.length > 1
      msg.send "Be more specific, I know #{users.length} people named like that: #{(user.name for user in users).join(", ")}"
    else
      msg.send "#{msg.match[2]}? Never heard of 'em"

  robot.respond /standup\?? *$/i, (msg) ->
    msg.send """
             <who> is a member of <team> - tell hubot who is the member of <team>'s standup
             standup for <team> - start the standup for <team>
             cancel standup - cancel the current standup
             next - say when your updates for the standup is done
             skip <who> - skip someone when they're not available
             """

  robot.catchAll (msg) ->
    unless robot.brain.data.standup?[msg.message.user.room]
      return
    # Don't record someone speaking out of turn. :-)
    if robot.brain.data.standup[msg.message.user.room].current.id isnt msg.message.user.id
      console.log "Ignoring #{msg.message.user.name} speaking out of turn during standup in #{msg.message.user.room}."
      return
    robot.brain.data.standup[msg.message.user.room].log or= {}
    robot.brain.data.standup[msg.message.user.room].log[msg.message.user.name] or= []
    robot.brain.data.standup[msg.message.user.room].log[msg.message.user.name].push { message: msg.message.text, time: Date.now() }

shuffleArrayClone = (array) ->
  cloned = []
  for i in (array.sort -> 0.5 - Math.random())
    cloned.push i
  cloned

nextPerson = (robot, db, room, msg) ->
  standup = robot.brain.data.standup[room]
  if standup.remaining.length == 0
    howlong = countdown(standup.start, Date.now()).toString()
    msg.send "All done! Standup was #{howlong}."

    dbStandup = {
      _id: "#{room}-#{moment(standup.start).format("YYYY-MM-DD")}",
      end: Date.now(),
      start: standup.start,
      duration: howlong,
      date: moment(standup.start).format("LL")
      log: standup.log,
      attendees: standup.attendees,
      group: standup.group.toTitleCase(),
    }
    db.standups.insert dbStandup, (err, res) ->
      if err
        msg.send "An error occurred while saving the standup logs, check the error log"
        console.log err
    
    delete robot.brain.data.standup[room]
  else
    standup.current = standup.remaining.shift()
    msg.send "#{addressUser(standup.current, robot.adapter)} your turn"

addressUser = (user, adapter) ->
  className = adapter.__proto__.constructor.name
  switch className
    when "HipChat" then "@#{user.name.replace(' ', '')}"
    when "SlackBot" then "<@#{user.id}>"
    else "#{user.name}:"

# Thanks, Stack Overflow
String::toTitleCase = ->
  i = undefined
  j = undefined
  str = undefined
  lowers = undefined
  uppers = undefined
  str = @replace(/([^\W_]+[^\s-]*) */g, (txt) ->
    txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
  )
  # Certain minor words should be left lowercase unless 
  # they are the first or last words in the string
  lowers = [
    'A'
    'An'
    'The'
    'And'
    'But'
    'Or'
    'For'
    'Nor'
    'As'
    'At'
    'By'
    'For'
    'From'
    'In'
    'Into'
    'Near'
    'Of'
    'On'
    'Onto'
    'To'
    'With'
  ]
  i = 0
  j = lowers.length
  while i < j
    str = str.replace(new RegExp('\\s' + lowers[i] + '\\s', 'g'), (txt) ->
      txt.toLowerCase()
    )
    i++
  # Certain words such as initialisms or acronyms should be left uppercase
  uppers = [
    'Id'
    'Tv'
  ]
  i = 0
  j = uppers.length
  while i < j
    str = str.replace(new RegExp('\\b' + uppers[i] + '\\b', 'g'), uppers[i].toUpperCase())
    i++
  str
