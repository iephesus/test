'use strict';

const { options } = require('../lib/options');
const { COMMANDS } = require('../lib/config');
function targetUid(value) {const uid=require('./ui/form-utils').uid(value);if(!uid)throw Error('请输入微博 UID，或带数字 UID 的用户主页链接');return uid;}

function validateSubject(input) { const post = input.mode === 'post-comments'; if (input.subject && (post ? (input.subject.kind !== 'post' || require('./ui/form-utils').postId(input.target) !== input.subject.id) : (input.subject.kind !== 'user' || targetUid(input.target) !== input.subject.uid)))
    throw Error('操作身份与目标不一致，请重新选择用户或微博'); }
function buildArguments(input = {}) {
    if (input.mode === 'comments-and-mentions')
        throw Error('桌面端请选择独立内容选项');
    if (!Object.hasOwn(COMMANDS, input.mode))
        throw Error('请选择支持的功能');
    const post = input.mode === 'post-comments', posts = input.mode === 'user-posts';
    if(input.source && input.source !== 'cli')throw Error('数据来源无效');
    validateSubject(input);
    const args = [post ? String(input.target ?? '').trim() : targetUid(input.target), input.mode];
    const policy = input.policy || 'cache';
    if (!['cache', 'update', 'refresh', 'offline', 'database'].includes(policy))
        throw Error('读取方式无效');
    if (policy !== 'cache')
        args.push('--' + policy);
    if (input.syncOnly)
        args.push('--sync-only');
    if (input.syncOnly && !post && !posts && input.syncOperation) {
        if (input.syncOperation === 'quick' && policy !== 'update')
            throw Error('快速检查更新需要增量操作');
        if (input.syncOperation === 'regular' && policy === 'update')
            throw Error('常规更新不能使用增量参数');
        args.push('--sync-operation', input.syncOperation);
    }
    if (input.syncOnly && !post && !posts) {
        addBudget();
    }
    function addBudget() { if (input.returnBudget!==undefined&&input.returnBudget!==null&&String(input.returnBudget).trim())
        args.push('--return-budget', String(input.returnBudget)); if (input.emptyWindowLimit!==undefined&&input.emptyWindowLimit!==null&&String(input.emptyWindowLimit).trim())
        args.push('--empty-window-limit', String(input.emptyWindowLimit)); }
    const add = (flag, value) => { if (value !== undefined && value !== null && String(value).trim())
        args.push(flag, String(value).trim()); };
    add('--limit', input.unlimited ? 'all' : input.limit ?? '50');
    if (policy !== 'database') {
        add('--pages', input.pages);
        add('--page-size', input.pageSize);
    }
    if (policy === 'database') {
        add('--from', input.from);
        add('--to', input.to);
        add('--batch', input.batch);
        if (input.newOnly)
            args.push('--new-only');
        if (input.unread)
            args.push('--unread');
    }
    else if (posts) {
        add('--from', input.from);
        add('--to', input.to);
        add('--empty-window-limit', input.emptyWindowLimit);
        if (input.downloadImages)
            args.push('--download-images');
        if (input.fullText)
            args.push('--full-text');
    }
    else {
        if (input.syncOnly) {
            add('--from', input.from);
            add('--to', input.to);
        }
        if (input.before)
            add('--before', input.before);
        if (input.seekLimit!==undefined&&input.seekLimit!==null&&String(input.seekLimit).trim() && (input.before || input.syncOnly && (input.from||input.to)))
            add('--seek-limit', input.seekLimit);
        if (input.historyRecovery === false)
            args.push('--no-history-recovery');
    }
    if (input.verbose)
        args.push('--verbose');
    if (input.preview)
        args.push('--dry-run');
    options(args);
    return args;
}
module.exports = { buildArguments, targetUid, validateSubject };
