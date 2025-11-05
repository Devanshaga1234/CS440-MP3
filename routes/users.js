module.exports = function (router) {

    var mongoose = require('mongoose');
    var User = require('../models/user');
    var Task = require('../models/task');

    function parseJSONParam(paramValue, paramName, res) {
        if (paramValue === undefined) return { ok: true, value: undefined };
        try {
            return { ok: true, value: JSON.parse(paramValue) };
        } catch (e) {
            res.status(400).json({ message: 'Invalid JSON for "' + paramName + '" parameter', data: {} });
            return { ok: false };
        }
    }

    function parseBooleanParam(value) {
        if (value === undefined) return false;
        if (typeof value === 'boolean') return value;
        return String(value).toLowerCase() === 'true';
    }

    function validateWhereIdsForResource(where, res, resourceName) {
        if (!where || typeof where !== 'object') return true;
        var objectId = mongoose.Types.ObjectId;
        if (typeof where._id === 'string') {
            if (!objectId.isValid(where._id)) {
                res.status(400).json({ message: 'The provided ' + resourceName + ' id is not valid', data: {} });
                return false;
            }
        } else if (where._id && typeof where._id === 'object' && Array.isArray(where._id.$in)) {
            var invalid = where._id.$in.find(function (v) { return typeof v !== 'string' || !objectId.isValid(String(v)); });
            if (invalid !== undefined) {
                res.status(400).json({ message: 'Invalid Ids for ' + resourceName, data: {} });
                return false;
            }
        }
        return true;
    }

    router.route('/users')
        .get(async function (req, res) {
            var whereP = parseJSONParam(req.query.where, 'where', res);
            if (!whereP.ok) return;
            var sortP = parseJSONParam(req.query.sort, 'sort', res);
            if (!sortP.ok) return;
            var selectP = parseJSONParam(req.query.select, 'select', res);
            if (!selectP.ok) return;

            var hasSkipParam = (req.query.skip !== undefined);
            var hasLimitParam = (req.query.limit !== undefined);
            var skip = req.query.skip ? parseInt(req.query.skip, 10) : 0;
            if (Number.isNaN(skip) || skip < 0) skip = 0;
            var limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : undefined;
            if (limit !== undefined && (Number.isNaN(limit) || limit < 0)) limit = undefined;
            var count = parseBooleanParam(req.query.count);

            try {
                if (!validateWhereIdsForResource(whereP.value, res, 'user')) return;
                if (count) {
                    var total = await User.countDocuments(whereP.value || {}).exec();
                    if (hasSkipParam || hasLimitParam) {
                        var afterSkip = Math.max(total - (hasSkipParam ? skip : 0), 0);
                        var pageCount = hasLimitParam ? Math.min(afterSkip, limit) : afterSkip;
                        return res.status(200).json({ message: 'Users count retrieved successfully', data: pageCount });
                    }
                    return res.status(200).json({ message: 'Users count retrieved successfully', data: total });
                }

                var totalMatchesUsers = await User.countDocuments(whereP.value || {}).exec();
                if (skip && skip >= totalMatchesUsers) {
                    return res.status(400).json({ message: 'Invalid Parameter', data: {} });
                }

                var query = User.find(whereP.value || {});
                if (sortP.value) query = query.sort(sortP.value);
                if (selectP.value) query = query.select(selectP.value);
                if (skip) query = query.skip(skip);
                if (limit !== undefined) query = query.limit(limit);

                var users = await query.exec();
                var byIdOnly = whereP.value && typeof whereP.value._id === 'string' && Object.keys(whereP.value).length === 1;
                if (byIdOnly && users.length === 0) {
                    return res.status(404).json({ message: 'User not found', data: {} });
                }
                var byIdInOnly = whereP.value && whereP.value._id && typeof whereP.value._id === 'object' && Array.isArray(whereP.value._id.$in) && Object.keys(whereP.value).length === 1;
                if (byIdInOnly) {
                    var requestedUserIds = whereP.value._id.$in.map(String);
                    var foundUserIds = users.map(function (u) { return String(u._id); });
                    var missingUserIds = requestedUserIds.filter(function (id) { return foundUserIds.indexOf(id) === -1; });
                    if (missingUserIds.length > 0) {
                        return res.status(404).json({ message: 'Ids not found', data: { missing: missingUserIds } });
                    }
                }
                return res.status(200).json({ message: 'Users retrieved successfully', data: users });
            } catch (e) {
                return res.status(500).json({ message: 'Unexpected server error.', data: {} });
            }
        })
        .post(async function (req, res) {
            try {
                if (!req.body || !req.body.name || !req.body.email) {
                    return res.status(400).json({ message: 'User name and email are required', data: {} });
                }

                var user = new User({
                    name: req.body.name,
                    email: req.body.email,
                    pendingTasks: []
                });

                var saved = await user.save();
                return res.status(201).json({ message: 'User created', data: saved });
            } catch (e) {
                if (e && e.code === 11000) {
                    return res.status(400).json({ message: 'A user with that email already exists', data: {} });
                }
                return res.status(400).json({ message: 'Unable to create user', data: {} });
            }
        });

    router.route('/users/:id')
        .get(async function (req, res) {
            var selectP = parseJSONParam(req.query.select, 'select', res);
            if (!selectP.ok) return;
            try {
                var query = User.findById(req.params.id);
                if (selectP.value) query = query.select(selectP.value);
                var user = await query.exec();
                if (!user) return res.status(404).json({ message: 'User not found', data: {} });
                return res.status(200).json({ message: 'User retrieved successfully', data: user });
            } catch (e) {
                return res.status(404).json({ message: 'User not found', data: {} });
            }
        })
        .put(async function (req, res) {
            try {
                var user = await User.findById(req.params.id).exec();
                if (!user) return res.status(404).json({ message: 'User not found', data: {} });

                var name = req.body && req.body.name;
                var email = req.body && req.body.email;
                if (!name || !email) return res.status(400).json({ message: 'User name and email are required', data: {} });

                var newPending = Array.isArray(req.body.pendingTasks) ? req.body.pendingTasks.map(String) : [];

                if (newPending.length > 0) {
                    var tasks = await Task.find({ _id: { $in: newPending } }).exec();
                    if (tasks.length !== newPending.length) {
                        return res.status(400).json({ message: 'Invalid pendingTasks', data: {} });
                    }
                    var invalid = tasks.find(function (t) { return t.completed === true || (t.assignedUser && t.assignedUser !== String(user._id)); });
                    if (invalid) {
                        return res.status(400).json({ message: 'Invalid pendingTasks', data: {} });
                    }
                }

                if (newPending.length > 0) {
                    await Task.updateMany(
                        { _id: { $in: newPending } },
                        { $set: { assignedUser: String(user._id), assignedUserName: name } }
                    ).exec();
                }

                await Task.updateMany(
                    { assignedUser: String(user._id), completed: false, _id: { $nin: newPending } },
                    { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
                ).exec();

                user.name = name;
                user.email = email;
                user.pendingTasks = newPending;
                var savedUser = await user.save();
                return res.status(200).json({ message: 'User updated', data: savedUser });
            } catch (e) {
                if (e && e.code === 11000) {
                    return res.status(400).json({ message: 'A user with that email already exists', data: {} });
                }
                return res.status(400).json({ message: 'Unable to update user', data: {} });
            }
        })
        .delete(async function (req, res) {
            try {
                var user = await User.findById(req.params.id).exec();
                if (!user) return res.status(404).json({ message: 'User not found', data: {} });

                await Task.updateMany(
                    { assignedUser: String(user._id) },
                    { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
                ).exec();

                await User.deleteOne({ _id: user._id }).exec();
                return res.status(204).json({ message: 'User deleted', data: {} });
            } catch (e) {
                return res.status(400).json({ message: 'Unable to delete user', data: {} });
            }
        });

    return router;
}


