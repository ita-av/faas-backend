/**
onCall funkcije so del Firebase Cloud Functions, 
ki omogočajo neposredno komunikacijo med odjemalsko aplikacijo in funkcijo v oblaku.

onRequest funkcije so del Firebase Cloud Functions in omogočajo 
uporabo splošnih HTTP zahtevkov za komunikacijo med odjemalcem in strežnikom.
*/

const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { beforeUserCreated } = require("firebase-functions/v2/identity");

admin.initializeApp();
const db = admin.firestore();

//functions
exports.helloWorld = functions.https.onRequest((req, res) => {
  res.send("Hello from Firebase Functions!");
});

/**
 * Trigger when file is uploaded to Firebase Storage
 */
exports.onFileUpload = onObjectFinalized(async (event) => {
  const object = event.data;
  const filePath = object.name;
  const contentType = object.contentType;
  const size = object.size;

  console.log(`New file uploaded: ${filePath}`);

  // Extract user ID from path like 'uploads/user123/document.docx'
  const match = filePath.match(/uploads\/([^/]+)\/(.+)/);
  if (!match) {
    console.log("File path format not recognized.");
    return;
  }

  const userId = match[1];
  const fileName = match[2];

  // Get a random user as lector (excluding the uploader)
  let lectorId = null;
  try {
    // Get all users from Firebase Auth
    const listUsersResult = await admin.auth().listUsers();
    const allUsers = listUsersResult.users;

    // Filter out the current user (uploader)
    const availableLectors = allUsers.filter((user) => user.uid !== userId);

    if (availableLectors.length > 0) {
      // Pick a random lector
      const randomIndex = Math.floor(Math.random() * availableLectors.length);
      lectorId = availableLectors[randomIndex].uid;
      console.log(`Assigned lector: ${lectorId}`);
    } else {
      console.log("No other users available as lectors");
    }
  } catch (error) {
    console.error("Error assigning lector:", error);
  }

  const docData = {
    fileName,
    filePath,
    contentType,
    size,
    userId,
    lectorId,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    notes: "",
    reviewedAt: null,
  };

  try {
    const docRef = await db.collection("submissions").add(docData);
    console.log("Submission metadata saved to Firestore");

    // Create notification for assigned lector that a new document is assigned
    if (lectorId) {
      await exports.createNotification(
        lectorId,
        "document_assigned",
        "New Document Assignment",
        `You have been assigned to review "${fileName}"`,
        {
          submissionId: docRef.id,
          fileName,
          userId,
        },
        `/review?id=${docRef.id}`
      );

      console.log(`Created assignment notification for lector ${lectorId}`);
    }
  } catch (error) {
    console.error("Error saving submission metadata:", error);
  }
});

// public
exports.example = functions.https.onCall((req) => {
  if (!req.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "User must be logged in."
    );
  }

  const uid = req.auth.uid;
  const email = req.auth.token.email;
  // continue logic
});

/**
 * Function to get all submissions for a specific user
 */
exports.getUserSubmissions = functions.https.onCall(async (req) => {
  if (!req.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "User must be logged in."
    );
  }

  const userId = req.auth.uid;

  try {
    const submissionsSnapshot = await db
      .collection("submissions")
      .where("userId", "==", userId)
      .get();

    const submissions = submissionsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return submissions;
  } catch (error) {
    console.error("Error fetching submissions:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Error fetching submissions"
    );
  }
});

/**
 * Function to get assigned submissions for current user as lector
 */
exports.getLectorSubmissions = functions.https.onCall(async (req) => {
  if (!req.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "User must be logged in."
    );
  }

  const lectorId = req.auth.uid;

  try {
    const submissionsSnapshot = await db
      .collection("submissions")
      .where("lectorId", "==", lectorId)
      .get();

    const submissions = submissionsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return submissions;
  } catch (error) {
    console.error("Error fetching lector submissions:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Error fetching submissions"
    );
  }
});

/**
 * Function to create a notification for a user
 * This function creates a notification document in the "notifications" collection
 * It expects the following parameters:
 * - userId: string, the ID of the user to notify
 * - type: string, the type of notification (e.g., "submission", "review")
 * - title: string, the title of the notification
 * - message: string, the message content of the notification
 * - data: object, optional additional data to include in the notification
 * - actionUrl: string, optional URL for an action button in the notification
 */
exports.createNotification = async (
  userId,
  type,
  title,
  message,
  data = {},
  actionUrl = null
) => {
  try {
    await db.collection("notifications").add({
      userId,
      type, // e.g., "document_reviewed", "document_assigned"
      title,
      message,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      data,
      actionUrl,
    });
    console.log(`Notification created for user ${userId}`);
  } catch (error) {
    console.error("Error creating notification:", error);
  }
};

/**
 * Function to update the status of a submission
 * This function updates the status and notes of a submission
 *
 * It expects data containing:
 * - submissionId: string, the ID of the submission
 * - status: string, the new status ("pending", "done")
 * - notes: string, optional notes for the submission
 */
exports.updateSubmission = functions.https.onCall(async (req) => {
  if (!req.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "User must be logged in."
    );
  }

  const { submissionId, status, notes } = req.data;
  const lectorId = req.auth.uid;

  if (!submissionId || !status) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Missing submissionId or status"
    );
  }

  const validStatuses = ["pending", "done"];
  if (!validStatuses.includes(status)) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Invalid status value"
    );
  }

  try {
    // Verify lector is assigned to this submission
    const submissionDoc = await db
      .collection("submissions")
      .doc(submissionId)
      .get();

    if (!submissionDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Submission not found");
    }

    const submissionData = submissionDoc.data();
    if (submissionData.lectorId !== lectorId) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "You can only update submissions assigned to you."
      );
    }

    await db
      .collection("submissions")
      .doc(submissionId)
      .update({
        status,
        notes: notes || "",
        reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Create notification for the document owner
    if (status === "done") {
      await exports.createNotification(
        submissionData.userId, // Notify the uploader
        "document_reviewed",
        "Document Review Complete",
        `Your document "${submissionData.fileName}" has been reviewed`,
        { submissionId, fileName: submissionData.fileName },
        `/review?id=${submissionId}`
      );
    }

    return { success: true };
  } catch (error) {
    console.error("Error updating status:", error);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throw new functions.https.HttpsError(
      "internal",
      "Error updating submission status"
    );
  }
});

// cronjob to clean up old notifications
exports.cleanupOldNotifications = onSchedule("0 * * * *", async (event) => {
  console.log("🧹 Starting notification cleanup job (v2)");

  try {
    // cutoff (1 hr)
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const now = Date.now();
    const cutoffDate = new Date(now - ONE_HOUR_MS);

    console.log(`Cutoff date: ${cutoffDate.toISOString()}`);

    const oldReadNotificationsSnapshot = await db
      .collection("notifications")
      .where("read", "==", true)
      .where("createdAt", "<", cutoffDate)
      .get();

    if (oldReadNotificationsSnapshot.empty) {
      console.log("No old read notifications found to delete");
      return;
    }

    // Batch delete (limit: 500)
    const batch = db.batch();
    let deleteCount = 0;

    oldReadNotificationsSnapshot.forEach((doc) => {
      batch.delete(doc.ref);
      deleteCount++;
      console.log(`Queued for deletion: ${doc.id}`);
    });

    // batch delete
    await batch.commit();

    console.log(`Successfully deleted ${deleteCount} old read notifications`);

    // Log summary
    console.log("Cleanup Summary:", {
      deletedCount: deleteCount,
      cutoffDate: cutoffDate.toISOString(),
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error during notification cleanup:", error);
  }
});
