import {beforeEach, describe, expect, it} from 'vitest';
import {WorkflowExecutionStatus, WorkflowStepType, WorkflowTriggerType} from '@plunk/db';
import {toPrismaJson} from '@plunk/types';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {TagService} from '../TagService.js';
import {WorkflowExecutionService} from '../WorkflowExecutionService.js';

/**
 * Tag-driven workflow dispatch:
 * - tag.added / tag.removed triggers scoped to a specific tagId
 * - ADD_TAG / REMOVE_TAG step execution
 * See EventService.test.ts for the base event -> workflow dispatch tests this extends.
 */
describe('EventService - tag-driven workflows', () => {
  let projectId: string;
  const prisma = getPrismaClient();

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  describe('tag.added / tag.removed triggers scoped by tagId', () => {
    it('starts the workflow when the applied tag matches the trigger tagId', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      const workflow = await factories.createWorkflow({
        projectId,
        enabled: true,
        triggerType: WorkflowTriggerType.EVENT,
        triggerConfig: {eventName: 'tag.added', tagId: tag.id},
      });

      await TagService.applyTags(projectId, contact.id, [tag.id]);

      const executions = await prisma.workflowExecution.findMany({
        where: {workflowId: workflow.id, contactId: contact.id},
      });
      expect(executions).toHaveLength(1);
    });

    it('does NOT start the workflow when a different tag is applied', async () => {
      const contact = await factories.createContact({projectId});
      const targetTag = await TagService.create(projectId, 'VIP');
      const otherTag = await TagService.create(projectId, 'Newsletter');

      const workflow = await factories.createWorkflow({
        projectId,
        enabled: true,
        triggerType: WorkflowTriggerType.EVENT,
        triggerConfig: {eventName: 'tag.added', tagId: targetTag.id},
      });

      await TagService.applyTags(projectId, contact.id, [otherTag.id]);

      const executions = await prisma.workflowExecution.findMany({where: {workflowId: workflow.id}});
      expect(executions).toHaveLength(0);
    });

    it('matches direction: removed against tag.removed only', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      // Workflows must exist before any tag event fires: triggerWorkflows caches
      // the project's enabled-workflow list for 5 minutes on first lookup, so an
      // event fired before both workflows exist would poison the cache with a
      // stale (smaller) list for the rest of this test.
      const addWorkflow = await factories.createWorkflow({
        projectId,
        enabled: true,
        triggerType: WorkflowTriggerType.EVENT,
        triggerConfig: {eventName: 'tag.added', tagId: tag.id},
      });
      const removeWorkflow = await factories.createWorkflow({
        projectId,
        enabled: true,
        triggerType: WorkflowTriggerType.EVENT,
        triggerConfig: {eventName: 'tag.removed', tagId: tag.id},
      });

      await TagService.applyTags(projectId, contact.id, [tag.id]);
      await TagService.removeTags(projectId, contact.id, [tag.id]);

      const addExecutions = await prisma.workflowExecution.findMany({where: {workflowId: addWorkflow.id}});
      const removeExecutions = await prisma.workflowExecution.findMany({where: {workflowId: removeWorkflow.id}});

      // applyTags fired tag.added (matches addWorkflow only), removeTags fired
      // tag.removed (matches removeWorkflow only) - each workflow triggers exactly once.
      expect(addExecutions).toHaveLength(1);
      expect(removeExecutions).toHaveLength(1);
    });

    it('is unaffected by a tag rename (binds by id, not name)', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'Old Name');

      const workflow = await factories.createWorkflow({
        projectId,
        enabled: true,
        triggerType: WorkflowTriggerType.EVENT,
        triggerConfig: {eventName: 'tag.added', tagId: tag.id},
      });

      await TagService.rename(projectId, tag.id, 'New Name');
      await TagService.applyTags(projectId, contact.id, [tag.id]);

      const executions = await prisma.workflowExecution.findMany({where: {workflowId: workflow.id}});
      expect(executions).toHaveLength(1);
    });

    it('respects allowReentry: false and does not re-trigger on a second matching tag event', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      const workflow = await factories.createWorkflow({
        projectId,
        enabled: true,
        allowReentry: false,
        triggerType: WorkflowTriggerType.EVENT,
        triggerConfig: {eventName: 'tag.added', tagId: tag.id},
      });

      await TagService.applyTags(projectId, contact.id, [tag.id]);
      await TagService.removeTags(projectId, contact.id, [tag.id]);
      await TagService.applyTags(projectId, contact.id, [tag.id]);

      const executions = await prisma.workflowExecution.findMany({where: {workflowId: workflow.id}});
      expect(executions).toHaveLength(1);
    });

    it('does not trigger a disabled workflow even on a matching tagged event', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      const workflow = await factories.createWorkflow({
        projectId,
        enabled: false,
        triggerType: WorkflowTriggerType.EVENT,
        triggerConfig: {eventName: 'tag.added', tagId: tag.id},
      });

      await TagService.applyTags(projectId, contact.id, [tag.id]);

      const executions = await prisma.workflowExecution.findMany({where: {workflowId: workflow.id}});
      expect(executions).toHaveLength(0);
    });
  });

  describe('ADD_TAG / REMOVE_TAG step execution', () => {
    it('ADD_TAG step applies the configured tag to the execution contact', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');

      const workflow = await factories.createWorkflow({projectId});
      const triggerStep = await prisma.workflowStep.findFirstOrThrow({
        where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
      });

      const addTagStep = await prisma.workflowStep.create({
        data: {
          workflowId: workflow.id,
          type: WorkflowStepType.ADD_TAG,
          name: 'Add VIP',
          position: {x: 100, y: 0},
          config: toPrismaJson({tagId: tag.id}),
        },
      });

      await prisma.workflowTransition.create({data: {fromStepId: triggerStep.id, toStepId: addTagStep.id}});

      const execution = await prisma.workflowExecution.create({
        data: {
          workflowId: workflow.id,
          contactId: contact.id,
          status: WorkflowExecutionStatus.RUNNING,
          currentStepId: triggerStep.id,
          context: toPrismaJson({}),
        },
      });

      await WorkflowExecutionService.processStepExecution(execution.id, triggerStep.id);
      await WorkflowExecutionService.processStepExecution(execution.id, addTagStep.id);

      const membership = await prisma.contactTag.findUnique({
        where: {contactId_tagId: {contactId: contact.id, tagId: tag.id}},
      });
      expect(membership).not.toBeNull();

      const reloadedTag = await prisma.tag.findUniqueOrThrow({where: {id: tag.id}});
      expect(reloadedTag.memberCount).toBe(1);
    });

    it('REMOVE_TAG step removes the configured tag from the execution contact', async () => {
      const contact = await factories.createContact({projectId});
      const tag = await TagService.create(projectId, 'VIP');
      await TagService.applyTags(projectId, contact.id, [tag.id]);

      const workflow = await factories.createWorkflow({projectId});
      const triggerStep = await prisma.workflowStep.findFirstOrThrow({
        where: {workflowId: workflow.id, type: WorkflowStepType.TRIGGER},
      });

      const removeTagStep = await prisma.workflowStep.create({
        data: {
          workflowId: workflow.id,
          type: WorkflowStepType.REMOVE_TAG,
          name: 'Remove VIP',
          position: {x: 100, y: 0},
          config: toPrismaJson({tagId: tag.id}),
        },
      });

      await prisma.workflowTransition.create({data: {fromStepId: triggerStep.id, toStepId: removeTagStep.id}});

      const execution = await prisma.workflowExecution.create({
        data: {
          workflowId: workflow.id,
          contactId: contact.id,
          status: WorkflowExecutionStatus.RUNNING,
          currentStepId: triggerStep.id,
          context: toPrismaJson({}),
        },
      });

      await WorkflowExecutionService.processStepExecution(execution.id, triggerStep.id);
      await WorkflowExecutionService.processStepExecution(execution.id, removeTagStep.id);

      const membership = await prisma.contactTag.findUnique({
        where: {contactId_tagId: {contactId: contact.id, tagId: tag.id}},
      });
      expect(membership).toBeNull();
    });
  });
});
