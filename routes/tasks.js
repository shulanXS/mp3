// Load required packages
var express = require('express'),
    mongoose = require('mongoose');

// Load required models
var User = require('../models/user');
var Task = require('../models/task');

// Load helpers
var h = require('./helpers');

// Use express router
var router = express.Router();

// GET all tasks
router.route('/').get(function (req, res) {
    h.handle(res, async function () {
        var q = h.query(req, 100);
        if (q.error) throw q.error;
        if (q.count) {
            var count = await Task.countDocuments(q.where);
            return res.status(200).json({ message: 'OK', data: count });
        }
        var tasks = await Task.find(q.where, q.select)
            .sort(q.sort).skip(q.skip).limit(q.limit).lean();
        res.status(200).json({ message: 'OK', data: tasks });
    });
});

// POST a new task
router.route('/').post(function (req, res) {
    h.handle(res, async function () {
        var fields = h.taskFields(req.body);
        await h.resolveAssignment(fields);
        var task = await Task.create({
            name: fields.name,
            description: fields.description,
            deadline: fields.deadline,
            completed: fields.completed,
            assignedUser: fields.assignedUser,
            assignedUserName: fields.assignedUserName,
            dateCreated: new Date()
        });
        await h.syncTask(task);
        res.status(201).json({ message: 'Task created', data: task.toObject() });
    });
});

// GET a task by id
router.route('/:id').get(function (req, res) {
    h.handle(res, async function () {
        var select = h.select(req);
        var task = mongoose.Types.ObjectId.isValid(req.params.id)
            ? await Task.findById(req.params.id, select).lean() : null;
        if (!task) throw h.missing('Task not found');
        res.status(200).json({ message: 'OK', data: task });
    });
});

// PUT a task by id
router.route('/:id').put(function (req, res) {
    h.handle(res, async function () {
        var task = await h.findTask(req.params.id);
        var previous = task.assignedUser;
        var fields = h.taskFields(req.body);
        await h.resolveAssignment(fields);
        task.name = fields.name;
        task.description = fields.description;
        task.deadline = fields.deadline;
        task.completed = fields.completed;
        task.assignedUser = fields.assignedUser;
        task.assignedUserName = fields.assignedUserName;
        await task.save();
        await h.syncTask(task, previous);
        res.status(200).json({ message: 'Task updated', data: task.toObject() });
    });
});

// DELETE a task by id
router.route('/:id').delete(function (req, res) {
    h.handle(res, async function () {
        var task = await h.findTask(req.params.id);
        if (task.assignedUser) {
            await User.updateOne({ _id: task.assignedUser },
                { $pull: { pendingTasks: task._id.toString() } });
        }
        await task.deleteOne();
        res.status(204).json({ message: 'Task deleted', data: '' });
    });
});

module.exports = router;