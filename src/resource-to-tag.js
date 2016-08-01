let log = require('./log');
let base = require('taskcluster-base');
let assert = require('assert');
let lodash = require('lodash');
let slugid = require('slugid');

const KEY_CONST = 'ResourceToTag';

// Store information about resources that ought to be tagged.
let ResourceToTag = base.Entity.configure({
  version: 1,
  partitionKey: base.Entity.keys.ConstantKey(KEY_CONST),
  rowKey: base.Entity.keys.StringKey('id'),
  properties: {
    // AWS Resource ID (e.g. ami-12345, i-12345...)
    id: base.Entity.types.String,
    // Region in which the resource to tag lives
    region: base.Entity.types.String,
    // Key value mapping of the tags that ought to be applied to this resource
    tags: base.Entity.types.JSON,
  },
});

/**
 * Override default functionality of the create to assert that
 * all tags are in the desired format.  Since we are not exposing
 * this entity through the API, we should ensure this somewhere
 */
ResourceToTag.create = function(id, region, tags) {
  assert(typeof id === 'string', 'id must be string');
  assert(typeof region === 'string', 'region must be string');
  assert(Array.isArray(tags), 'tags must be a list of {Key: ..., Value: ...}');
  validateTags(tags);
  return base.Entity.create.call(this, {id, region, tags});
};

/**
 * Decide whether a list of tags is in the right format.  Because JS doesn't
 * handle Unicode in a sane way, i'm defaulting to measuring strings with
 * .length.  This should give us the property of failing this check before
 * allowing an invalid tagset to the api.  Since we're never going to likely
 * use this outside of the provisioner internals, we're probably ok with this
 */
function validateTags (tags) {
  // http://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Using_Tags.html#tag-restrictions
  let valid = true;

  // Maximum number of tags per resource—10
  if (tags.length > 10) {
    valid = false;
  }

  for (let tag of tags) {
    function r(reason) {
      log.debug({badTag: tag.Key + ': ' + tag.Value, tags: tags}, reason);
    }
    
    if (typeof tag.Key !== 'string' || typeof tag.Value !== 'string') {
      r('not a string');
      valid = false;
    }
    // Maximum key length—127 Unicode characters in UTF-8
    // Maximum value length—255 Unicode characters in UTF-8
    if (tag.Key.length > 127 || tag.Value.length > 255) {
      r('max length exceeded');
      valid = false;
    }

    // Do not use the aws: prefix in your tag names or values because it is
    // reserved for AWS use.
    if (tag.Key.indexOf('ami:') === 0) {
      r('incorrectly using ami: prefix');
      valid = false;
    }

    // Generally allowed characters are: letters, spaces, and numbers
    // representable in UTF-8, plus the following special characters: + - = . _
    // : / @. NOTE: this regex isn't perfect
    if (/^[^a-zA-Z0-9+=.:/@]$/.exec(tag.Key + tag.Value)) {
      r('using invalid chars');
      valid = false;
    }
  }
  
  if (valid) {
    return true;
  } else {
    return false;
  }
}

/**
 * Return Value for a tag from a TagSet (array of tags)
 */
function getVal(tagSet, key) {
  for (let tag of tagSet) {
    if (tag.Key === key) {
      return tag.Value;
    }
  }

  return undefined
}

module.exports = {
  ResourceToTag,
  validateTags,
};
