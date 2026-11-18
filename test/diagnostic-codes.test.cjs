'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {safe}=require('../lib/diagnostic-codes');
test('fixed identity, local-profile and native safety failures survive the shareable diagnostic projection',()=>{
 for(const code of ['RECORD_ID_UNRELIABLE','LOCAL_PROFILE_SOURCE_INVALID','LOCAL_SOURCE_INVALID','REQUEST_EVIDENCE_INVALID'])assert.equal(safe(code),code);
 for(const value of ['PRIVATE_CREDENTIAL_TEXT','RECORD_ID_UNRELIABLE/private/path',new String('LOCAL_PROFILE_SOURCE_INVALID'),{code:'LOCAL_PROFILE_SOURCE_INVALID'},null,25])assert.equal(safe(value),'UNKNOWN');
});
test('Node and Swift diagnostic classifications stay identical',()=>{
 const fs=require('node:fs'),path=require('node:path'),nodeSource=fs.readFileSync(require.resolve('../lib/diagnostic-codes'),'utf8'),swiftSource=fs.readFileSync(path.join(__dirname,'../desktop/FeedbackDiagnostics.swift'),'utf8');
 const nodeList=nodeSource.match(/const codes=new Set\(\[(.*?)\]\)/s)[1],swiftList=swiftSource.match(/static let codes: Set<String> = \[(.*?)\]/s)[1];
 assert.deepEqual([...nodeList.matchAll(/'([^']+)'/g)].map(x=>x[1]).sort(),[...swiftList.matchAll(/"([^"]+)"/g)].map(x=>x[1]).sort());
});
