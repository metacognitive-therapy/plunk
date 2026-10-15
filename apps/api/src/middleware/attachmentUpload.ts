import {CHAT_ATTACHMENT_MAX_BYTES} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';
import multer from 'multer';

import {ErrorCode, HttpException} from '../exceptions/index.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {fileSize: CHAT_ATTACHMENT_MAX_BYTES, files: 1, fields: 2, fieldSize: 64 * 1024},
}).single('file');

/**
 * Parses one `file` field of a multipart chat upload. Mount it after authentication so an
 * anonymous caller cannot make the API buffer a body, and note that multer stops reading at the
 * size limit, so an oversized file is refused before anything is stored.
 */
export function chatAttachmentUpload(req: Request, res: Response, next: NextFunction) {
  upload(req, res, error => {
    if (!error) {
      if (!req.file) {
        return next(new HttpException(400, 'Attach a file in the "file" field', ErrorCode.MISSING_REQUIRED_FIELD));
      }
      return next();
    }
    if (error instanceof multer.MulterError) {
      return next(
        error.code === 'LIMIT_FILE_SIZE'
          ? new HttpException(413, 'Files can be up to 10 MB', ErrorCode.BAD_REQUEST)
          : new HttpException(400, 'Send one file at a time', ErrorCode.BAD_REQUEST),
      );
    }
    return next(new HttpException(400, 'The upload could not be read', ErrorCode.BAD_REQUEST));
  });
}
