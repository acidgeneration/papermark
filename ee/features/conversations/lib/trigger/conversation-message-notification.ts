import { logger, task } from "@trigger.dev/sdk/v3";

import prisma from "@/lib/prisma";
import { ZViewerNotificationPreferencesSchema } from "@/lib/zod/schemas/notifications";

type NotificationPayload = {
  dataroomId: string;
  messageId: string;
  conversationId: string;
  teamId: string;
  senderUserId: string;
};

export const sendConversationMessageNotificationTask = task({
  id: "send-conversation-message-notification",
  retry: { maxAttempts: 3 },
  run: async (payload: NotificationPayload) => {
    // Get all verified viewers for this dataroom
    const participants = await prisma.conversationParticipant.findMany({
      where: {
        conversationId: payload.conversationId,
        receiveNotifications: true,
        viewer: {
          verified: true,
        },
      },
      select: {
        id: true,
        viewer: {
          select: {
            id: true,
            notificationPreferences: true,
            views: {
              where: {
                conversationViews: {
                  some: {
                    conversationId: payload.conversationId,
                  },
                },
              },
              take: 1,
              select: {
                link: {
                  select: {
                    id: true,
                    slug: true,
                    domainSlug: true,
                    domainId: true,
                    isArchived: true,
                    expiresAt: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!participants || participants.length === 0) {
      logger.info("No participants found for this conversation", {
        conversationId: payload.conversationId,
      });
      return;
    }

    // Construct simplified viewer objects with link information
    const viewersWithLinks = participants
      .map((participant) => {
        if (!participant.viewer) {
          return null;
        }

        const viewer = participant.viewer;

        // Skip if notifications are disabled for this dataroom
        const parsedPreferences =
          ZViewerNotificationPreferencesSchema.safeParse(
            viewer.notificationPreferences,
          );
        if (
          parsedPreferences.success &&
          parsedPreferences.data.dataroom[payload.dataroomId]?.enabled === false
        ) {
          logger.info("Viewer notifications are disabled for this dataroom", {
            viewerId: viewer.id,
            conversationId: payload.conversationId,
            dataroomId: payload.dataroomId,
          });
          return null;
        }

        // Get the link from the conversationView
        const link = viewer.views[0]?.link;

        // Skip if link is expired or archived
        if (
          !link ||
          link.isArchived ||
          (link.expiresAt && new Date(link.expiresAt) < new Date())
        ) {
          logger.info("Link is expired or archived", {
            conversationId: payload.conversationId,
            link,
          });
          return null;
        }

        let linkUrl = "";
        if (link.domainId && link.domainSlug && link.slug) {
          linkUrl = `https://${link.domainSlug}/${link.slug}`;
        } else {
          linkUrl = `${process.env.NEXT_PUBLIC_MARKETING_URL}/view/${link.id}`;
        }

        return {
          id: viewer.id,
          linkUrl,
        };
      })
      .filter(
        (participant): participant is { id: string; linkUrl: string } =>
          participant !== null,
      );

    logger.info("Processed viewer links", {
      viewerCount: viewersWithLinks.length,
    });

    // Send notification to each viewer
    for (const viewer of viewersWithLinks) {
      try {
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_BASE_URL}/api/jobs/send-conversation-new-message-notification`,
          {
            method: "POST",
            body: JSON.stringify({
              conversationId: payload.conversationId,
              dataroomId: payload.dataroomId,
              linkUrl: viewer.linkUrl,
              viewerId: viewer.id,
              senderUserId: payload.senderUserId,
              teamId: payload.teamId,
            }),
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.INTERNAL_API_KEY}`,
            },
          },
        );

        if (!response.ok) {
          logger.error("Failed to send dataroom notification", {
            viewerId: viewer.id,
            dataroomId: payload.dataroomId,
            error: await response.text(),
          });
          continue;
        }

        const { message } = (await response.json()) as { message: string };
        logger.info("Notification sent successfully", {
          viewerId: viewer.id,
          message,
        });
      } catch (error) {
        logger.error("Error sending notification", {
          viewerId: viewer.id,
          error,
        });
      }
    }

    logger.info("Completed sending notifications", {
      dataroomId: payload.dataroomId,
      conversationId: payload.conversationId,
      viewerCount: viewersWithLinks.length,
    });
    return;
  },
});
