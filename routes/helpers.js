// Load required packages
var mongoose = require('mongoose');
var User = require('../models/user');
var Task = require('../models/task');

// Errors carry the status code to send to the client
function bad(message) { return { status: 400, message: message }; }
function missing(message) { return { status: 404, message: message }; }

// Run a handler and convert thrown errors into {message, data} responses
async function handle(res, fn) {
    try {
        await fn();
    } catch (e) {
        var status = e.status;
        var message = e.message;
        if (!status) {
            // never let Mongoose or MongoDB wording reach the client
            if (e.name === 'ValidationError' || e.name === 'CastError') {
                status = 400;
                message = 'Invalid value';
            } else if (e.code === 51091 || e.code === 2) {
                // e.g. an invalid $regex inside where
                status = 400;
                message = 'Invalid where parameter';
            } else {
                status = 500;
                message = 'Internal server error';
            }
        }
        res.status(status).json({ message: message, data: '' });
    }
}

// A JSON query parameter must be well formed and be an object
function parse(value, name) {
    if (value === undefined) return undefined;
    var parsed;
    try {
        parsed = JSON.parse(value);
    } catch (e) {
        throw bad('Invalid ' + name + ' parameter');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw bad('Invalid ' + name + ' parameter');
    return parsed;
}

// Skip and limit must be non negative integers
function num(value, name) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw bad('Invalid ' + name + ' parameter');
    return Number(value);
}

// Parse the JSON encoded query string parameters
function query(req, defaultLimit) {
    try {
        var select = parse(req.query.select, 'select');
        return {
            where: parse(req.query.where, 'where') || {},
            sort: parse(req.query.sort, 'sort') || {},
            select: select === undefined ? null : select,
            skip: req.query.skip === undefined ? 0 : num(req.query.skip, 'skip'),
            limit: req.query.limit === undefined ? defaultLimit : num(req.query.limit, 'limit'),
            count: String(req.query.count).toLowerCase() === 'true' || req.query.count === '1',
            error: null
        };
    } catch (e) {
        return { error: e };
    }
}

// Only select is supported on /:id endpoints
function select(req) {
    var parsed = parse(req.query.select, 'select');
    return parsed === undefined ? null : parsed;
}

function toDate(value) {
    var date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
}

// An id in a request body must be well formed (400) and must exist (404)
async function resolveTask(id) {
    if (typeof id !== 'string' || !mongoose.Types.ObjectId.isValid(id)) throw bad('Invalid task id');
    var task = await Task.findById(id).lean();
    if (!task) throw missing('Task not found');
    return task;
}

async function findUser(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw missing('User not found');
    var user = await User.findById(id);
    if (!user) throw missing('User not found');
    return user;
}

async function findTask(id) {
    if (!mongoose.Types.ObjectId.isValid(id)) throw missing('Task not found');
    var task = await Task.findById(id);
    if (!task) throw missing('Task not found');
    return task;
}

// Every id in pendingTasks must be an existing, not completed task
async function loadTasks(ids) {
    for (var id of ids) {
        var task = await resolveTask(id);
        if (task.completed) throw bad('A completed task cannot be in pendingTasks');
    }
}

// assignedUser and assignedUserName must refer to the same user
async function resolveAssignment(task) {
    if (typeof task.assignedUser !== 'string') throw bad('assignedUser must be a string');
    if (task.assignedUser === '') {
        if (task.assignedUserName !== undefined && task.assignedUserName !== 'unassigned')
            throw bad('assignedUserName must match assignedUser');
        task.assignedUserName = 'unassigned';
        return;
    }
    if (!mongoose.Types.ObjectId.isValid(task.assignedUser)) throw bad('Invalid user id');
    var user = await User.findById(task.assignedUser).lean();
    if (!user) throw missing('User not found');
    if (task.assignedUserName !== undefined && task.assignedUserName !== user.name)
        throw bad('assignedUserName must match assignedUser');
    task.assignedUserName = user.name;
}

// Keep pendingTasks in sync with a saved task
async function syncTask(task, previousUser) {
    var id = task._id.toString();
    if (task.assignedUser) {
        var update = task.completed
            ? { $pull: { pendingTasks: id } }
            : { $addToSet: { pendingTasks: id } };
        await User.updateOne({ _id: task.assignedUser }, update);
    }
    if (previousUser && previousUser !== task.assignedUser) {
        await User.updateOne({ _id: previousUser }, { $pull: { pendingTasks: id } });
    }
}

// Keep tasks in sync with a saved user
async function syncUser(user) {
    var id = user._id.toString();
    var pendingTasks = user.pendingTasks || [];
    await Task.updateMany({ assignedUser: id, completed: { $ne: true }, _id: { $nin: pendingTasks } },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } });
    if (pendingTasks.length) {
        var owners = await Task.find({
            _id: { $in: pendingTasks },
            assignedUser: { $nin: ['', id] }
        }, '_id assignedUser').lean();
        for (var other of owners) {
            await User.updateOne({ _id: other.assignedUser },
                { $pull: { pendingTasks: other._id.toString() } });
        }
        await Task.updateMany({ _id: { $in: pendingTasks } },
            { $set: { assignedUser: id, assignedUserName: user.name } });
    }
    await Task.updateMany({ assignedUser: id }, { $set: { assignedUserName: user.name } });
}

// Name and email are required on every user
function userFields(body) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw bad('name is required');
    if (typeof body.email !== 'string' || !body.email.trim()) throw bad('email is required');
    var pendingTasks = body.pendingTasks;
    if (pendingTasks === undefined) return { name: body.name, email: body.email, pendingTasks: [] };
    if (!Array.isArray(pendingTasks)) throw bad('pendingTasks must be an array');
    for (var id of pendingTasks) {
        if (typeof id !== 'string') throw bad('Invalid task id');
    }
    return { name: body.name, email: body.email, pendingTasks: pendingTasks };
}

// Name and deadline are required on every task, other fields get defaults
function taskFields(body) {
    if (typeof body.name !== 'string' || !body.name.trim()) throw bad('name is required');
    if (body.deadline === undefined) throw bad('deadline is required');
    if (typeof body.deadline !== 'string') throw bad('deadline must be a date string');
    var deadline = toDate(body.deadline);
    if (!deadline) throw bad('deadline must be a valid date');
    if (body.description !== undefined && typeof body.description !== 'string')
        throw bad('description must be a string');
    if (body.completed !== undefined && typeof body.completed !== 'boolean')
        throw bad('completed must be a boolean');
    if (body.assignedUserName !== undefined && typeof body.assignedUserName !== 'string')
        throw bad('assignedUserName must be a string');
    return {
        name: body.name,
        description: body.description || '',
        deadline: deadline,
        completed: body.completed || false,
        assignedUser: body.assignedUser === undefined ? '' : body.assignedUser,
        assignedUserName: body.assignedUserName
    };
}

module.exports = {
    bad: bad, missing: missing, handle: handle, query: query, select: select,
    findUser: findUser, findTask: findTask, loadTasks: loadTasks,
    resolveAssignment: resolveAssignment, syncTask: syncTask, syncUser: syncUser,
    userFields: userFields, taskFields: taskFields
};