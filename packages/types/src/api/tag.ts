/**
 * Tag service types
 */

export interface CreateTagData {
  name: string;
}

export interface UpdateTagData {
  name: string;
}

export interface TagReference {
  id: string;
  name: string;
}

export interface TagWithCount extends TagReference {
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
}
