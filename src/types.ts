export type ArtistProps = {
  uid: string;
  name: string;
  location: string;
  releases: ReleaseProps[];
};

export type AvatarProps = {
  user: any;
  handleLogout: () => void;
};

export type ReleaseProps = {
  name: string;
  artist: string;
  codes: string[];
  image: string;
  link: string;
  releaseDate: string;
  releaseType: string;
};
