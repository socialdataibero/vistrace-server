import { UserSanitizedModel } from './user.sanitized.model';

export class LoginResponse {
  token!: string;
  user!: UserSanitizedModel;
  iberoDownloadToken?: string;
  iberoContext?: Record<string, unknown> | null;
  canvas?: Record<string, unknown> | null;
}
