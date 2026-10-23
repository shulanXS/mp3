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

// GET all users
router.route('/').get(function (req, res) {
    h.handle(res, async function () {
        var q = h.query(req, 0);
        if (q.error) throw q.error;
        if (q.count) {
            var count = await User.countDocuments(q.where);
            return res.status(200).json({ message: 'OK', data: count });
        }
        var users = await User.find(q.where, q.select)
            .sort(q.sort).skip(q.skip).limit(q.limit).lean();
        res.status(200).json({ message: 'OK', data: users });
    });
});

// POST a new user
router.route('/').post(function (req, res) {
    h.handle(res, async function () {
        var fields = h.userFields(req.body);
        var taken = await User.findOne({ email: fields.email });
        if (taken) throw h.bad('Email is already in use');
        await h.loadTasks(fields.pendingTasks);
        var user = await User.create({
            name: fields.name,
            email: fields.email,
            pendingTasks: fields.pendingTasks,
            dateCreated: new Date()
        });
        await h.syncUser(user);
        res.status(201).json({ message: 'User created', data: user.toObject() });
    });
});

// GET a user by id
router.route('/:id').get(function (req, res) {
    h.handle(res, async function () {
        var select = h.select(req);
        var user = mongoose.Types.ObjectId.isValid(req.params.id)
            ? await User.findById(req.params.id, select).lean() : null;
        if (!user) throw h.missing('User not found');
        res.status(200).json({ message: 'OK', data: user });
    });
});

// PUT a user by id
router.route('/:id').put(function (req, res) {
    h.handle(res, async function () {
        var user = await h.findUser(req.params.id);
        var fields = h.userFields(req.body);
        var taken = await User.findOne({ email: fields.email });
        if (taken && !taken._id.equals(user._id)) throw h.bad('Email is already in use');
        await h.loadTasks(fields.pendingTasks);
        user.name = fields.name;
        user.email = fields.email;
        user.pendingTasks = fields.pendingTasks;
        await user.save();
        await h.syncUser(user);
        res.status(200).json({ message: 'User updated', data: user.toObject() });
    });
});

// DELETE a user by id
router.route('/:id').delete(function (req, res) {
    h.handle(res, async function () {
        var user = await h.findUser(req.params.id);
        await Task.updateMany({ assignedUser: user._id.toString() },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } });
        await user.deleteOne();
        res.status(204).json({ message: 'User deleted', data: '' });
    });
});

module.exports = router;