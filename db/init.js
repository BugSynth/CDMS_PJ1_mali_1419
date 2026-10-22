require('dotenv').config();

const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const databaseName = process.env.MONGODB_DB || 'questionnaire_system';

const objectId = { bsonType: 'objectId' };
const date = { bsonType: 'date' };
const string = { bsonType: 'string' };

const definitions = [
  {
    name: 'users',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['username', 'passwordHash', 'registeredAt'],
        properties: {
          username: { ...string, minLength: 3, maxLength: 64 },
          passwordHash: { ...string, minLength: 20 },
          registeredAt: date,
          updatedAt: date
        }
      }
    },
    indexes: [{ key: { username: 1 }, options: { unique: true, name: 'username_unique' } }]
  },
  {
    name: 'surveys',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['ownerId', 'shortId', 'title', 'allowAnonymous', 'allowMultipleResponses', 'status', 'createdAt', 'updatedAt'],
        properties: {
          ownerId: objectId,
          shortId: { ...string, minLength: 6, maxLength: 32 },
          title: { ...string, minLength: 1, maxLength: 200 },
          description: { ...string, maxLength: 5000 },
          allowAnonymous: { bsonType: 'bool' },
          allowMultipleResponses: { bsonType: 'bool' },
          status: { enum: ['draft', 'published', 'closed'] },
          publishedAt: date,
          closesAt: date,
          closedAt: date,
          createdAt: date,
          updatedAt: date
        }
      }
    },
    indexes: [
      { key: { shortId: 1 }, options: { unique: true, name: 'short_id_unique' } },
      { key: { ownerId: 1, createdAt: -1 }, options: { name: 'owner_survey_list' } },
      { key: { status: 1, closesAt: 1 }, options: { name: 'availability_lookup' } }
    ]
  },
  {
    name: 'questions',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['surveyId', 'order', 'type', 'prompt', 'required', 'validation', 'createdAt', 'updatedAt'],
        properties: {
          surveyId: objectId,
          order: { bsonType: 'int', minimum: 1 },
          type: { enum: ['single_choice', 'multiple_choice', 'text', 'number'] },
          prompt: { ...string, minLength: 1, maxLength: 5000 },
          required: { bsonType: 'bool' },
          options: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              required: ['key', 'text', 'order'],
              properties: {
                key: { ...string, pattern: '^[A-Za-z0-9_-]{1,64}$' },
                text: { ...string, minLength: 1, maxLength: 1000 },
                order: { bsonType: 'int', minimum: 1 }
              }
            }
          },
          validation: { bsonType: 'object' },
          createdAt: date,
          updatedAt: date
        }
      }
    },
    indexes: [
      { key: { surveyId: 1, order: 1 }, options: { unique: true, name: 'question_order_per_survey' } },
      { key: { surveyId: 1, type: 1 }, options: { name: 'question_type_by_survey' } }
    ]
  },
  {
    name: 'jump_rules',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['surveyId', 'sourceQuestionId', 'condition', 'targetQuestionId', 'priority', 'enabled', 'createdAt', 'updatedAt'],
        properties: {
          surveyId: objectId,
          sourceQuestionId: objectId,
          targetQuestionId: objectId,
          priority: { bsonType: 'int', minimum: 1 },
          enabled: { bsonType: 'bool' },
          condition: {
            bsonType: 'object',
            required: ['answerType', 'operator'],
            properties: {
              answerType: { enum: ['single_choice', 'multiple_choice', 'number'] },
              operator: { enum: ['equals', 'includes_any', 'includes_all', 'count_equals', 'count_gte', 'count_lte', 'gt', 'gte', 'lt', 'lte', 'between'] },
              optionKeys: { bsonType: 'array', items: string },
              value: { bsonType: ['double', 'int', 'long', 'decimal'] },
              min: { bsonType: ['double', 'int', 'long', 'decimal'] },
              max: { bsonType: ['double', 'int', 'long', 'decimal'] }
            }
          },
          createdAt: date,
          updatedAt: date
        }
      }
    },
    indexes: [
      { key: { surveyId: 1, sourceQuestionId: 1, enabled: 1, priority: 1 }, options: { name: 'rules_for_source_question' } },
      { key: { surveyId: 1, targetQuestionId: 1 }, options: { name: 'rules_by_target' } }
    ]
  },
  {
    name: 'responses',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['surveyId', 'isAnonymous', 'status', 'startedAt', 'createdAt', 'updatedAt'],
        properties: {
          surveyId: objectId,
          respondentId: { bsonType: ['objectId', 'null'] },
          submissionKey: string,
          isAnonymous: { bsonType: 'bool' },
          visitedQuestionIds: { bsonType: 'array', items: objectId },
          status: { enum: ['in_progress', 'submitted', 'abandoned'] },
          startedAt: date,
          submittedAt: date,
          createdAt: date,
          updatedAt: date
        }
      }
    },
    indexes: [
      { key: { surveyId: 1, status: 1, submittedAt: -1 }, options: { name: 'survey_submission_list' } },
      { key: { surveyId: 1, respondentId: 1, startedAt: -1 }, options: { name: 'respondent_response_list' } },
      { key: { surveyId: 1, submissionKey: 1 }, options: { unique: true, sparse: true, name: 'one_submission_per_respondent_when_limited' } }
    ]
  },
  {
    name: 'answers',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['responseId', 'surveyId', 'questionId', 'questionType', 'value', 'answeredAt'],
        properties: {
          responseId: objectId,
          surveyId: objectId,
          questionId: objectId,
          questionType: { enum: ['single_choice', 'multiple_choice', 'text', 'number'] },
          value: {},
          answeredAt: date,
          questionOrderSnapshot: { bsonType: 'int', minimum: 1 }
        }
      }
    },
    indexes: [
      { key: { responseId: 1, questionId: 1 }, options: { unique: true, name: 'one_answer_per_question_per_response' } },
      { key: { surveyId: 1, questionId: 1, questionType: 1 }, options: { name: 'question_statistics' } },
      { key: { surveyId: 1, questionId: 1, value: 1 }, options: { name: 'choice_and_number_aggregation' } }
    ]
  }
];

async function ensureCollection(db, definition) {
  const exists = await db.listCollections({ name: definition.name }, { nameOnly: true }).hasNext();
  if (!exists) {
    await db.createCollection(definition.name, { validator: definition.validator, validationLevel: 'strict', validationAction: 'error' });
  } else {
    await db.command({ collMod: definition.name, validator: definition.validator, validationLevel: 'strict', validationAction: 'error' });
  }
  for (const index of definition.indexes) await db.collection(definition.name).createIndex(index.key, index.options);
}

async function main() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(databaseName);
    for (const definition of definitions) await ensureCollection(db, definition);
    console.log(`Initialized ${databaseName}: ${definitions.map(({ name }) => name).join(', ')}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
