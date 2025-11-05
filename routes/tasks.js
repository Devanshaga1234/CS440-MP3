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

    function parseBooleanBody(value) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            var lower = value.toLowerCase();
            if (lower === 'true') return true;
            if (lower === 'false') return false;
        }
        return !!value;
    }

    function parseDeadlineValue(value) {
        if (value === undefined || value === null) return null;
        var num = Number(value);
        if (!Number.isNaN(num) && Number.isFinite(num)) {
            var ms = Math.round(num);
            var d1 = new Date(ms);
            if (!Number.isNaN(d1.getTime())) return d1;
        }
        var d2 = new Date(value);
        if (!Number.isNaN(d2.getTime())) return d2;
        return null;
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

    router.route('/tasks')
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
            var limit = req.query.limit !== undefined ? parseInt(req.query.limit, 10) : 100; 
            if (Number.isNaN(limit) || limit < 0) limit = 100;
            var count = parseBooleanParam(req.query.count);

            try {
                if (!validateWhereIdsForResource(whereP.value, res, 'task')) return;
                if (count) {
                    var total = await Task.countDocuments(whereP.value || {}).exec();
                    if (hasSkipParam || hasLimitParam) {
                        var afterSkip = Math.max(total - (hasSkipParam ? skip : 0), 0);
                        var pageCount = hasLimitParam ? Math.min(afterSkip, limit) : afterSkip;
                        return res.status(200).json({ message: 'Tasks count retrieved successfully', data: pageCount });
                    }
                    return res.status(200).json({ message: 'Tasks count retrieved successfully', data: total });
                }

                var totalMatches = await Task.countDocuments(whereP.value || {}).exec();
                if (skip && skip >= totalMatches) {
                    return res.status(400).json({ message: 'Invalid Parameter', data: {} });
                }

                var query = Task.find(whereP.value || {});
                if (sortP.value) query = query.sort(sortP.value);
                if (selectP.value) query = query.select(selectP.value);
                if (skip) query = query.skip(skip);
                if (limit !== undefined) query = query.limit(limit);

                var tasks = await query.exec();
                var byIdOnlyT = whereP.value && typeof whereP.value._id === 'string' && Object.keys(whereP.value).length === 1;
                if (byIdOnlyT && tasks.length === 0) {
                    return res.status(404).json({ message: 'Task not found', data: {} });
                }
                var byIdInOnlyT = whereP.value && whereP.value._id && typeof whereP.value._id === 'object' && Array.isArray(whereP.value._id.$in) && Object.keys(whereP.value).length === 1;
                if (byIdInOnlyT) {
                    var requestedTaskIds = whereP.value._id.$in.map(String);
                    var foundTaskIds = tasks.map(function (t) { return String(t._id); });
                    var missingTaskIds = requestedTaskIds.filter(function (id) { return foundTaskIds.indexOf(id) === -1; });
                    if (missingTaskIds.length > 0) {
                        return res.status(404).json({ message: 'Ids not found', data: { missing: missingTaskIds } });
                    }
                }
                return res.status(200).json({ message: 'Tasks retrieved successfully', data: tasks });
            } catch (e) {
                return res.status(500).json({ message: 'Unexpected server error.', data: {} });
            }
        })
        .post(async function (req, res) {
            try {
                if (!req.body || !req.body.name || !req.body.deadline) {
                    return res.status(400).json({ message: 'Task name and deadline are required', data: {} });
                }

                var assignedUserId = req.body.assignedUser ? String(req.body.assignedUser) : '';
                var assignedUserName = 'unassigned';

                if (assignedUserId) {
                    var assignedUser = await User.findById(assignedUserId).exec();
                    if (!assignedUser) return res.status(400).json({ message: 'assignedUser is invalid', data: {} });
                    assignedUserName = assignedUser.name;
                }

                var parsedDeadline = parseDeadlineValue(req.body.deadline);
                if (!parsedDeadline) return res.status(400).json({ message: 'Invalid deadline value', data: {} });

                var task = new Task({
                    name: req.body.name,
                    description: req.body.description || '',
                    deadline: parsedDeadline,
                    completed: parseBooleanBody(req.body.completed),
                    assignedUser: assignedUserId,
                    assignedUserName: assignedUserName
                });

                var savedTask = await task.save();

                if (assignedUserId && savedTask.completed === false) {
                    await User.updateOne(
                        { _id: assignedUserId },
                        { $addToSet: { pendingTasks: String(savedTask._id) } }
                    ).exec();
                }

                return res.status(201).json({ message: 'Task created', data: savedTask });
            } catch (e) {
                return res.status(400).json({ message: 'Unable to create task', data: {} });
            }
        });

    router.route('/tasks/:id')
        .get(async function (req, res) {
            var selectP = parseJSONParam(req.query.select, 'select', res);
            if (!selectP.ok) return;
            try {
                var query = Task.findById(req.params.id);
                if (selectP.value) query = query.select(selectP.value);
                var task = await query.exec();
                if (!task) return res.status(404).json({ message: 'Task not found', data: {} });
                return res.status(200).json({ message: 'Task retrieved successfully', data: task });
            } catch (e) {
                return res.status(404).json({ message: 'Task not found', data: {} });
            }
        })
        .put(async function (req, res) {
            try {
                var task = await Task.findById(req.params.id).exec();
                if (!task) return res.status(404).json({ message: 'Task not found', data: {} });

                var name = req.body && req.body.name;
                var deadline = req.body && req.body.deadline;
                if (!name || !deadline) return res.status(400).json({ message: 'Task name and deadline are required', data: {} });

                var description = req.body.description || '';
                var completed = parseBooleanBody(req.body.completed);
                var newAssignedUserId = req.body.assignedUser ? String(req.body.assignedUser) : '';
                var newAssignedUserName = 'unassigned';

                var oldAssignedUserId = task.assignedUser ? String(task.assignedUser) : '';

                if (newAssignedUserId) {
                    var newAssignedUser = await User.findById(newAssignedUserId).exec();
                    if (!newAssignedUser) return res.status(400).json({ message: 'assignedUser is invalid', data: {} });
                    newAssignedUserName = newAssignedUser.name;
                }

                var parsedDeadline2 = parseDeadlineValue(deadline);
                if (!parsedDeadline2) return res.status(400).json({ message: 'Invalid deadline value', data: {} });

                task.name = name;
                task.description = description;
                task.deadline = parsedDeadline2;
                task.completed = completed;
                task.assignedUser = newAssignedUserId;
                task.assignedUserName = newAssignedUserName;

                var savedTask = await task.save();

                if (oldAssignedUserId) {
                    await User.updateOne(
                        { _id: oldAssignedUserId },
                        { $pull: { pendingTasks: String(savedTask._id) } }
                    ).exec();
                }

                if (newAssignedUserId && savedTask.completed === false) {
                    await User.updateOne(
                        { _id: newAssignedUserId },
                        { $addToSet: { pendingTasks: String(savedTask._id) } }
                    ).exec();
                }

                return res.status(200).json({ message: 'Task updated', data: savedTask });
            } catch (e) {
                return res.status(400).json({ message: 'Unable to update task', data: {} });
            }
        })
        .delete(async function (req, res) {
            try {
                var task = await Task.findById(req.params.id).exec();
                if (!task) return res.status(404).json({ message: 'Task not found', data: {} });

                if (task.assignedUser) {
                    await User.updateOne(
                        { _id: String(task.assignedUser) },
                        { $pull: { pendingTasks: String(task._id) } }
                    ).exec();
                }

                await Task.deleteOne({ _id: task._id }).exec();
                return res.status(204).json({ message: 'Task deleted', data: {} });
            } catch (e) {
                return res.status(400).json({ message: 'Unable to delete task', data: {} });
            }
        });

    return router;
}


